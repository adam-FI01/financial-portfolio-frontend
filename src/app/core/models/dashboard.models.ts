export type AccountType = 'CHECKING' | 'SAVINGS' | 'CREDIT_CARD' | 'INVESTMENT' | 'LOAN' | 'OTHER';

export interface Institution {
  id: string;
  plaidInstitutionId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  institutionId: string;
  plaidAccountId: string | null;
  name: string;
  type: AccountType;
  currentBalance: number;
  availableBalance: number | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/** Sign convention: negative = money out (debit), positive = money in (credit). */
export interface Transaction {
  id: string;
  accountId: string;
  plaidTransactionId: string | null;
  amount: number;
  description: string;
  category: string | null;
  transactionDate: string;
  pending: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PageResponse<T> {
  items: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}
