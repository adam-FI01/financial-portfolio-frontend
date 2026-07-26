import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';

import { AuthService } from '../../core/services/auth.service';
import { DashboardService } from '../../core/services/dashboard.service';
import { Account, AccountType, Institution, PageResponse, Transaction } from '../../core/models/dashboard.models';

const PAGE_SIZE = 20;
const ASSET_TYPES: AccountType[] = ['CHECKING', 'SAVINGS', 'INVESTMENT'];
const LIABILITY_TYPES: AccountType[] = ['CREDIT_CARD', 'LOAN'];

const MIN_LOADER_MS = 3000;
const LOADER_FADE_MS = 500;
const LOADER_PHRASES = [
  'Establishing secure connection…',
  'Syncing institutions & accounts…',
  'Finalizing your portfolio…'
];

interface CategoryTotal {
  category: string;
  total: number;
}

interface DonutSegment {
  category: string;
  total: number;
  percent: number;
  color: string;
}

// Validated categorical palette (dark-mode steps), skipping the palette's green
// slot since green is reserved elsewhere in this app for CTAs/success states.
// Passes all six dataviz checks (lightness, chroma, CVD, contrast) against our
// dark surface — see the palette validation run for this feature.
const DONUT_COLORS = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#9085e9', // violet
  '#e66767' // red
];
const DONUT_OTHER_COLOR = '#6b7280'; // neutral gray — matches --color-text-tertiary
const DONUT_MAX_SEGMENTS = DONUT_COLORS.length;

type AccountFilterValue = 'ALL' | AccountType;

interface AccountFilterOption {
  label: string;
  value: AccountFilterValue;
}

interface InstitutionGroup {
  institution: Institution;
  accounts: Account[];
  subtotal: number;
}

const ACCOUNT_FILTERS: AccountFilterOption[] = [
  { label: 'All', value: 'ALL' },
  { label: 'Checking', value: 'CHECKING' },
  { label: 'Savings', value: 'SAVINGS' },
  { label: 'Credit Cards', value: 'CREDIT_CARD' },
  { label: 'Loans', value: 'LOAN' },
  { label: 'Investments', value: 'INVESTMENT' }
];

interface MonthComparison {
  thisMonthSpend: number;
  lastMonthSpend: number;
  difference: number;
  percentChange: number | null;
}

function yearMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, DecimalPipe],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss'
})
export class Dashboard implements OnInit, OnDestroy {
  readonly showIntroLoader = signal(true);
  readonly loaderLeaving = signal(false);
  readonly contentVisible = signal(false);
  readonly loaderStatusText = signal(LOADER_PHRASES[0]);
  readonly minLoaderMs = MIN_LOADER_MS;
  readonly loaderFadeMs = LOADER_FADE_MS;

  private loadStartedAt = 0;
  private phraseIntervalId?: ReturnType<typeof setInterval>;
  private dismissTimeoutId?: ReturnType<typeof setTimeout>;
  private removeLoaderTimeoutId?: ReturnType<typeof setTimeout>;

  readonly institutions = signal<Institution[]>([]);
  readonly accounts = signal<Account[]>([]);
  readonly loadingAccounts = signal(true);
  readonly accountsError = signal<string | null>(null);

  readonly transactionsPage = signal<PageResponse<Transaction> | null>(null);
  readonly loadingTransactions = signal(true);
  readonly hasLoadedTransactionsOnce = signal(false);
  readonly transactionsError = signal<string | null>(null);
  readonly currentPage = signal(0);

  readonly allTransactions = signal<Transaction[]>([]);
  readonly loadingInsights = signal(true);
  readonly insightsError = signal<string | null>(null);

  readonly accountFilters = ACCOUNT_FILTERS;
  readonly accountFilter = signal<AccountFilterValue>('ALL');
  readonly collapsedInstitutions = signal<Set<string>>(new Set());

  readonly hasAccounts = computed(() => this.accounts().length > 0);
  readonly accountsById = computed(() => new Map(this.accounts().map((a) => [a.id, a])));

  readonly filteredAccounts = computed(() => {
    const filter = this.accountFilter();
    return filter === 'ALL' ? this.accounts() : this.accounts().filter((a) => a.type === filter);
  });

  readonly institutionGroups = computed<InstitutionGroup[]>(() => {
    const byInstitution = new Map<string, Account[]>();
    for (const account of this.filteredAccounts()) {
      const list = byInstitution.get(account.institutionId) ?? [];
      list.push(account);
      byInstitution.set(account.institutionId, list);
    }

    return this.institutions()
      .filter((institution) => byInstitution.has(institution.id))
      .map((institution) => {
        const accounts = byInstitution.get(institution.id)!;
        const subtotal = accounts.reduce((sum, a) => sum + a.currentBalance, 0);
        return { institution, accounts, subtotal };
      });
  });

  readonly totalAssets = computed(() =>
    this.accounts()
      .filter((a) => ASSET_TYPES.includes(a.type))
      .reduce((sum, a) => sum + a.currentBalance, 0)
  );

  readonly totalLiabilities = computed(() =>
    this.accounts()
      .filter((a) => LIABILITY_TYPES.includes(a.type))
      .reduce((sum, a) => sum + Math.abs(a.currentBalance), 0)
  );

  readonly netWorth = computed(() => this.totalAssets() - this.totalLiabilities());

  readonly spendingByCategory = computed<CategoryTotal[]>(() => {
    const monthKey = currentMonthKey();
    const totals = new Map<string, number>();
    for (const t of this.allTransactions()) {
      if (t.amount >= 0 || yearMonthKey(t.transactionDate) !== monthKey) {
        continue;
      }
      const key = t.category ?? 'Uncategorized';
      totals.set(key, (totals.get(key) ?? 0) + Math.abs(t.amount));
    }
    return [...totals.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
  });

  readonly totalSpend = computed(() => this.spendingByCategory().reduce((sum, row) => sum + row.total, 0));

  readonly donutSegments = computed<DonutSegment[]>(() => {
    const rows = this.spendingByCategory();
    const total = this.totalSpend();
    if (total === 0) {
      return [];
    }

    const primaryCount = Math.min(rows.length, DONUT_MAX_SEGMENTS);
    const segments = rows.slice(0, primaryCount).map((row, i) => ({
      category: row.category,
      total: row.total,
      percent: (row.total / total) * 100,
      color: DONUT_COLORS[i]
    }));

    const rest = rows.slice(primaryCount);
    if (rest.length > 0) {
      const restTotal = rest.reduce((sum, row) => sum + row.total, 0);
      segments.push({
        category: 'Other',
        total: restTotal,
        percent: (restTotal / total) * 100,
        color: DONUT_OTHER_COLOR
      });
    }

    return segments;
  });

  readonly donutGradient = computed(() => {
    const segments = this.donutSegments();
    if (segments.length === 0) {
      return 'transparent';
    }
    if (segments.length === 1) {
      return segments[0].color;
    }

    const gapDeg = 2.5;
    let cursor = 0;
    const stops: string[] = [];

    for (const segment of segments) {
      const sweep = (segment.percent / 100) * 360;
      const start = cursor;
      const end = cursor + sweep;
      const gapStart = Math.max(start, end - gapDeg);
      stops.push(`${segment.color} ${start}deg ${gapStart}deg`);
      stops.push(`var(--color-surface) ${gapStart}deg ${end}deg`);
      cursor = end;
    }

    return `conic-gradient(${stops.join(', ')})`;
  });

  readonly monthComparison = computed<MonthComparison>(() => {
    const now = new Date();
    const thisMonthKey = currentMonthKey();
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

    let thisMonthSpend = 0;
    let lastMonthSpend = 0;

    for (const t of this.allTransactions()) {
      if (t.amount >= 0) {
        continue;
      }
      const key = yearMonthKey(t.transactionDate);
      if (key === thisMonthKey) {
        thisMonthSpend += Math.abs(t.amount);
      } else if (key === lastMonthKey) {
        lastMonthSpend += Math.abs(t.amount);
      }
    }

    const difference = thisMonthSpend - lastMonthSpend;
    const percentChange = lastMonthSpend > 0 ? (difference / lastMonthSpend) * 100 : null;

    return { thisMonthSpend, lastMonthSpend, difference, percentChange };
  });

  constructor(
    private readonly authService: AuthService,
    private readonly dashboardService: DashboardService,
    private readonly router: Router
  ) {}

  ngOnInit(): void {
    this.loadStartedAt = Date.now();
    this.startLoaderPhraseCycle();
    this.loadAccounts();
  }

  ngOnDestroy(): void {
    clearInterval(this.phraseIntervalId);
    clearTimeout(this.dismissTimeoutId);
    clearTimeout(this.removeLoaderTimeoutId);
  }

  logout(): void {
    this.authService.logout();
    this.router.navigateByUrl('/login');
  }

  setAccountFilter(value: AccountFilterValue): void {
    this.accountFilter.set(value);
  }

  toggleInstitution(institutionId: string): void {
    const next = new Set(this.collapsedInstitutions());
    if (next.has(institutionId)) {
      next.delete(institutionId);
    } else {
      next.add(institutionId);
    }
    this.collapsedInstitutions.set(next);
  }

  isInstitutionCollapsed(institutionId: string): boolean {
    return this.collapsedInstitutions().has(institutionId);
  }

  accountCurrency(transaction: Transaction): string {
    return this.accountsById().get(transaction.accountId)?.currency ?? 'USD';
  }

  monthBarWidth(value: number): number {
    const { thisMonthSpend, lastMonthSpend } = this.monthComparison();
    const max = Math.max(thisMonthSpend, lastMonthSpend);
    return max > 0 ? (value / max) * 100 : 0;
  }

  accountTypeLabel(type: AccountType): string {
    return type
      .toLowerCase()
      .split('_')
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(' ');
  }

  formatRelativeTime(isoDate: string): string {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const diffSeconds = Math.floor(diffMs / 1000);

    if (diffSeconds < 60) {
      return 'Updated just now';
    }
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) {
      return `Updated ${diffMinutes} min ago`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return `Updated ${diffHours} hr ago`;
    }
    const diffDays = Math.floor(diffHours / 24);
    return `Updated ${diffDays}d ago`;
  }

  goToPage(page: number): void {
    const page_ = this.transactionsPage();
    if (this.loadingTransactions() || page < 0 || (page_ && page >= page_.totalPages)) {
      return;
    }
    this.currentPage.set(page);
    this.loadTransactions(page);
  }

  private startLoaderPhraseCycle(): void {
    let index = 0;
    this.phraseIntervalId = setInterval(() => {
      index = (index + 1) % LOADER_PHRASES.length;
      this.loaderStatusText.set(LOADER_PHRASES[index]);
    }, MIN_LOADER_MS / LOADER_PHRASES.length);
  }

  private dismissIntroLoaderWhenReady(): void {
    clearInterval(this.phraseIntervalId);
    const elapsed = Date.now() - this.loadStartedAt;
    const remaining = Math.max(MIN_LOADER_MS - elapsed, 0);

    this.dismissTimeoutId = setTimeout(() => {
      this.contentVisible.set(true);
      this.loaderLeaving.set(true);
      this.removeLoaderTimeoutId = setTimeout(() => this.showIntroLoader.set(false), LOADER_FADE_MS);
    }, remaining);
  }

  private loadAccounts(): void {
    this.loadingAccounts.set(true);
    this.accountsError.set(null);

    forkJoin({
      institutions: this.dashboardService.getInstitutions(),
      accounts: this.dashboardService.getAccounts()
    }).subscribe({
      next: ({ institutions, accounts }) => {
        this.institutions.set(institutions);
        this.accounts.set(accounts);
        this.loadingAccounts.set(false);
        this.dismissIntroLoaderWhenReady();

        if (accounts.length > 0) {
          this.loadTransactions(0);
          this.loadInsights();
        } else {
          this.loadingTransactions.set(false);
          this.loadingInsights.set(false);
        }
      },
      error: () => {
        this.accountsError.set("Couldn't load your accounts. Please try again.");
        this.loadingAccounts.set(false);
        this.loadingTransactions.set(false);
        this.loadingInsights.set(false);
        this.dismissIntroLoaderWhenReady();
      }
    });
  }

  private loadTransactions(page: number): void {
    this.loadingTransactions.set(true);
    this.transactionsError.set(null);

    this.dashboardService.getTransactions(page, PAGE_SIZE).subscribe({
      next: (result) => {
        this.transactionsPage.set(result);
        this.loadingTransactions.set(false);
        this.hasLoadedTransactionsOnce.set(true);
      },
      error: () => {
        this.transactionsError.set("Couldn't load your transactions. Please try again.");
        this.loadingTransactions.set(false);
      }
    });
  }

  private loadInsights(): void {
    this.loadingInsights.set(true);
    this.insightsError.set(null);

    this.dashboardService.getAllTransactions().subscribe({
      next: (transactions) => {
        this.allTransactions.set(transactions);
        this.loadingInsights.set(false);
      },
      error: () => {
        this.insightsError.set("Couldn't load insights right now.");
        this.loadingInsights.set(false);
      }
    });
  }
}
