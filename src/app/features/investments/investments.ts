import { CurrencyPipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';

import { DashboardService } from '../../core/services/dashboard.service';
import { Holding } from '../../core/models/dashboard.models';
import { Header } from '../../shared/header/header';

const TOP_HOLDINGS_COUNT = 5;

type SortColumn =
  | 'symbol'
  | 'name'
  | 'shares'
  | 'currentValue'
  | 'costBasis'
  | 'gainLoss'
  | 'gainLossPercent'
  | 'portfolioPercent';

type SortDirection = 'asc' | 'desc';
type ViewMode = 'grouped' | 'combined';

interface HoldingRow extends Holding {
  portfolioPercent: number;
}

interface AccountGroup {
  accountId: string;
  accountName: string;
  institutionName: string;
  holdings: HoldingRow[];
  totalValue: number;
}

interface AccountOption {
  accountId: string;
  accountName: string;
  institutionName: string;
}

@Component({
  selector: 'app-investments',
  standalone: true,
  imports: [CurrencyPipe, DecimalPipe, RouterLink, NgTemplateOutlet, Header],
  templateUrl: './investments.html',
  styleUrl: './investments.scss'
})
export class Investments implements OnInit, OnDestroy {
  readonly holdings = signal<Holding[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly viewMode = signal<ViewMode>('grouped');
  readonly sortColumn = signal<SortColumn>('currentValue');
  readonly sortDirection = signal<SortDirection>('desc');
  readonly collapsedAccounts = signal<Set<string>>(new Set());

  // Populated from the ?accountId query param — null means "All Portfolio".
  // Set by the header nav link (no query params) or the account dropdown.
  readonly selectedAccountId = signal<string | null>(null);
  private queryParamSubscription?: Subscription;

  readonly accountOptions = computed<AccountOption[]>(() => {
    const seen = new Map<string, AccountOption>();
    for (const h of this.holdings()) {
      if (!seen.has(h.accountId)) {
        seen.set(h.accountId, {
          accountId: h.accountId,
          accountName: h.accountName,
          institutionName: h.institutionName
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.accountName.localeCompare(b.accountName));
  });

  // Everything below derives from this instead of `holdings()` directly, so
  // selecting a single account scopes the whole page (header stats, top
  // holdings, table) to just that account.
  readonly filteredHoldings = computed(() => {
    const accountId = this.selectedAccountId();
    return accountId ? this.holdings().filter((h) => h.accountId === accountId) : this.holdings();
  });

  readonly totalCurrentValue = computed(() => this.filteredHoldings().reduce((sum, h) => sum + h.currentValue, 0));
  readonly totalCostBasis = computed(() => this.filteredHoldings().reduce((sum, h) => sum + h.costBasis, 0));
  readonly totalGainLoss = computed(() => this.totalCurrentValue() - this.totalCostBasis());
  readonly totalGainLossPercent = computed(() => {
    const basis = this.totalCostBasis();
    return basis > 0 ? (this.totalGainLoss() / basis) * 100 : 0;
  });

  // Top-5 bars are proportional to the largest of those 5 (not the whole
  // portfolio), so the widest bar always reaches 100% regardless of how
  // concentrated or spread out the portfolio is.
  readonly topHoldings = computed(() =>
    [...this.filteredHoldings()].sort((a, b) => b.currentValue - a.currentValue).slice(0, TOP_HOLDINGS_COUNT)
  );
  readonly topHoldingsMaxValue = computed(() => this.topHoldings().reduce((max, h) => Math.max(max, h.currentValue), 0));

  readonly enrichedHoldings = computed<HoldingRow[]>(() => {
    const total = this.totalCurrentValue();
    return this.filteredHoldings().map((h) => ({
      ...h,
      portfolioPercent: total > 0 ? (h.currentValue / total) * 100 : 0
    }));
  });

  readonly sortedHoldings = computed(() => this.sortRows(this.enrichedHoldings()));

  readonly accountGroups = computed<AccountGroup[]>(() => {
    const byAccount = new Map<string, HoldingRow[]>();
    for (const holding of this.enrichedHoldings()) {
      const list = byAccount.get(holding.accountId) ?? [];
      list.push(holding);
      byAccount.set(holding.accountId, list);
    }

    return [...byAccount.values()]
      .map((rows) => ({
        accountId: rows[0].accountId,
        accountName: rows[0].accountName,
        institutionName: rows[0].institutionName,
        holdings: this.sortRows(rows),
        totalValue: rows.reduce((sum, r) => sum + r.currentValue, 0)
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
  });

  readonly hasMultipleAccounts = computed(() => this.accountGroups().length > 1);

  constructor(
    private readonly dashboardService: DashboardService,
    private readonly route: ActivatedRoute,
    private readonly router: Router
  ) {}

  ngOnInit(): void {
    this.loadHoldings();
    this.queryParamSubscription = this.route.queryParamMap.subscribe((params) => {
      this.selectedAccountId.set(params.get('accountId'));
    });
  }

  ngOnDestroy(): void {
    this.queryParamSubscription?.unsubscribe();
  }

  onAccountSelect(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { accountId: value || null },
      queryParamsHandling: 'merge'
    });
  }

  topHoldingBarWidth(value: number): number {
    const max = this.topHoldingsMaxValue();
    return max > 0 ? (value / max) * 100 : 0;
  }

  setSortColumn(column: SortColumn): void {
    if (this.sortColumn() === column) {
      this.sortDirection.set(this.sortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortColumn.set(column);
      this.sortDirection.set(column === 'symbol' || column === 'name' ? 'asc' : 'desc');
    }
  }

  sortIndicator(column: SortColumn): string {
    if (this.sortColumn() !== column) {
      return '';
    }
    return this.sortDirection() === 'asc' ? '▲' : '▼';
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
  }

  toggleAccount(accountId: string): void {
    const next = new Set(this.collapsedAccounts());
    if (next.has(accountId)) {
      next.delete(accountId);
    } else {
      next.add(accountId);
    }
    this.collapsedAccounts.set(next);
  }

  isAccountCollapsed(accountId: string): boolean {
    return this.collapsedAccounts().has(accountId);
  }

  private sortRows(rows: HoldingRow[]): HoldingRow[] {
    const column = this.sortColumn();
    const direction = this.sortDirection() === 'asc' ? 1 : -1;

    return [...rows].sort((a, b) => {
      const aVal = a[column];
      const bVal = b[column];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return aVal.localeCompare(bVal) * direction;
      }
      return ((aVal as number) - (bVal as number)) * direction;
    });
  }

  private loadHoldings(): void {
    this.loading.set(true);
    this.error.set(null);

    this.dashboardService.getHoldings().subscribe({
      next: (holdings) => {
        this.holdings.set(holdings);
        this.loading.set(false);
      },
      error: () => {
        this.error.set("Couldn't load your investments. Please try again.");
        this.loading.set(false);
      }
    });
  }
}
