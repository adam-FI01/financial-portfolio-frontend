import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Subject, Subscription, debounceTime, distinctUntilChanged, forkJoin } from 'rxjs';

import { AuthService } from '../../core/services/auth.service';
import { DashboardService } from '../../core/services/dashboard.service';
import {
  Account,
  AccountType,
  Holding,
  Institution,
  PageResponse,
  Transaction
} from '../../core/models/dashboard.models';
import { DONUT_COLORS, DONUT_OTHER_COLOR, DonutChart, DonutSegment } from '../../shared/donut-chart/donut-chart';
import { Header } from '../../shared/header/header';

const SEARCH_DEBOUNCE_MS = 350;
const HIGH_UTILIZATION_THRESHOLD = 70;
const TOP_HOLDINGS_PREVIEW_COUNT = 3;

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

interface CreditUtilization {
  percent: number;
  balanceMagnitude: number;
  limit: number;
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
  imports: [CurrencyPipe, DatePipe, DecimalPipe, RouterLink, Header, DonutChart],
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
  readonly searchQuery = signal('');
  readonly selectedCategory = signal<string | null>(null);

  private readonly searchInput$ = new Subject<string>();
  private searchSubscription?: Subscription;

  readonly allTransactions = signal<Transaction[]>([]);
  readonly loadingInsights = signal(true);
  readonly insightsError = signal<string | null>(null);

  readonly holdings = signal<Holding[]>([]);
  readonly loadingHoldings = signal(true);

  readonly accountFilters = ACCOUNT_FILTERS;
  readonly accountFilter = signal<AccountFilterValue>('ALL');
  readonly collapsedInstitutions = signal<Set<string>>(new Set());

  readonly hasAccounts = computed(() => this.accounts().length > 0);
  readonly accountsById = computed(() => new Map(this.accounts().map((a) => [a.id, a])));

  readonly holdingsByAccountId = computed(() => {
    const map = new Map<string, Holding[]>();
    for (const holding of this.holdings()) {
      const list = map.get(holding.accountId) ?? [];
      list.push(holding);
      map.set(holding.accountId, list);
    }
    return map;
  });

  readonly availableCategories = computed(() => {
    const categories = new Set<string>();
    for (const t of this.allTransactions()) {
      if (t.category) {
        categories.add(t.category);
      }
    }
    return [...categories].sort();
  });

  readonly hasActiveTransactionFilters = computed(
    () => this.searchQuery().trim() !== '' || this.selectedCategory() !== null
  );

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
      label: row.category,
      total: row.total,
      percent: (row.total / total) * 100,
      color: DONUT_COLORS[i]
    }));

    const rest = rows.slice(primaryCount);
    if (rest.length > 0) {
      const restTotal = rest.reduce((sum, row) => sum + row.total, 0);
      segments.push({
        label: 'Other',
        total: restTotal,
        percent: (restTotal / total) * 100,
        color: DONUT_OTHER_COLOR
      });
    }

    return segments;
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

    this.searchSubscription = this.searchInput$
      .pipe(debounceTime(SEARCH_DEBOUNCE_MS), distinctUntilChanged())
      .subscribe((value) => {
        this.searchQuery.set(value);
        this.currentPage.set(0);
        this.loadTransactions(0);
      });
  }

  ngOnDestroy(): void {
    clearInterval(this.phraseIntervalId);
    clearTimeout(this.dismissTimeoutId);
    clearTimeout(this.removeLoaderTimeoutId);
    this.searchSubscription?.unsubscribe();
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

  creditUtilization(account: Account): CreditUtilization | null {
    if (account.type !== 'CREDIT_CARD' || !account.creditLimit || account.creditLimit <= 0) {
      return null;
    }
    const balanceMagnitude = Math.abs(account.currentBalance);
    const percent = Math.min((balanceMagnitude / account.creditLimit) * 100, 100);
    return { percent, balanceMagnitude, limit: account.creditLimit };
  }

  isHighUtilization(utilization: CreditUtilization): boolean {
    return utilization.percent >= HIGH_UTILIZATION_THRESHOLD;
  }

  topHoldingsForAccount(accountId: string): Holding[] {
    const holdings = this.holdingsByAccountId().get(accountId) ?? [];
    return [...holdings].sort((a, b) => b.currentValue - a.currentValue).slice(0, TOP_HOLDINGS_PREVIEW_COUNT);
  }

  onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchInput$.next(value);
  }

  onCategoryChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.selectedCategory.set(value || null);
    this.currentPage.set(0);
    this.loadTransactions(0);
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

        if (accounts.some((a) => a.type === 'INVESTMENT')) {
          this.loadHoldings();
        } else {
          this.loadingHoldings.set(false);
        }
      },
      error: () => {
        this.accountsError.set("Couldn't load your accounts. Please try again.");
        this.loadingAccounts.set(false);
        this.loadingTransactions.set(false);
        this.loadingInsights.set(false);
        this.loadingHoldings.set(false);
        this.dismissIntroLoaderWhenReady();
      }
    });
  }

  private loadTransactions(page: number): void {
    this.loadingTransactions.set(true);
    this.transactionsError.set(null);

    const search = this.searchQuery().trim() || undefined;
    const category = this.selectedCategory() ?? undefined;

    this.dashboardService.getTransactions(page, PAGE_SIZE, search, category).subscribe({
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

  private loadHoldings(): void {
    this.loadingHoldings.set(true);

    this.dashboardService.getHoldings().subscribe({
      next: (holdings) => {
        this.holdings.set(holdings);
        this.loadingHoldings.set(false);
      },
      error: () => {
        this.loadingHoldings.set(false);
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
