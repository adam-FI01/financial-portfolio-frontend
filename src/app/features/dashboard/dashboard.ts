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

interface MonthComparison {
  thisMonthSpend: number;
  lastMonthSpend: number;
  difference: number;
  percentChange: number | null;
}

function yearMonthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
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
  readonly transactionsError = signal<string | null>(null);
  readonly currentPage = signal(0);

  readonly allTransactions = signal<Transaction[]>([]);
  readonly loadingInsights = signal(true);
  readonly insightsError = signal<string | null>(null);

  readonly hasAccounts = computed(() => this.accounts().length > 0);
  readonly institutionsById = computed(() => new Map(this.institutions().map((i) => [i.id, i])));
  readonly accountsById = computed(() => new Map(this.accounts().map((a) => [a.id, a])));

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
    const totals = new Map<string, number>();
    for (const t of this.allTransactions()) {
      if (t.amount >= 0) {
        continue;
      }
      const key = t.category ?? 'Uncategorized';
      totals.set(key, (totals.get(key) ?? 0) + Math.abs(t.amount));
    }
    return [...totals.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
  });

  readonly maxCategoryTotal = computed(() => this.spendingByCategory()[0]?.total ?? 0);

  readonly monthComparison = computed<MonthComparison>(() => {
    const now = new Date();
    const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

  institutionName(account: Account): string {
    return this.institutionsById().get(account.institutionId)?.name ?? 'Unknown institution';
  }

  accountCurrency(transaction: Transaction): string {
    return this.accountsById().get(transaction.accountId)?.currency ?? 'USD';
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
    if (page < 0 || (page_ && page >= page_.totalPages)) {
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
