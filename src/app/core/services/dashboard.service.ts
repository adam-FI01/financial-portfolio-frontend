import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { EMPTY, Observable, concatMap, expand, from, toArray } from 'rxjs';

import { API_BASE_URL } from '../config/api.config';
import { Account, Institution, PageResponse, Transaction } from '../models/dashboard.models';

const INSIGHTS_PAGE_SIZE = 100;

@Injectable({ providedIn: 'root' })
export class DashboardService {
  constructor(private readonly http: HttpClient) {}

  getInstitutions(): Observable<Institution[]> {
    return this.http.get<Institution[]>(`${API_BASE_URL}/institutions`);
  }

  getAccounts(): Observable<Account[]> {
    return this.http.get<Account[]>(`${API_BASE_URL}/accounts`);
  }

  getTransactions(page: number, size: number): Observable<PageResponse<Transaction>> {
    const params = new HttpParams().set('page', page).set('size', size);
    return this.http.get<PageResponse<Transaction>>(`${API_BASE_URL}/transactions`, { params });
  }

  /**
   * Fetches every transaction by paging through the existing endpoint (no new
   * backend route) — used for aggregate insights that must cover the whole
   * dataset rather than just whatever page the transaction list is showing.
   */
  getAllTransactions(): Observable<Transaction[]> {
    return this.getTransactions(0, INSIGHTS_PAGE_SIZE).pipe(
      expand((page) => (page.page + 1 < page.totalPages ? this.getTransactions(page.page + 1, INSIGHTS_PAGE_SIZE) : EMPTY)),
      concatMap((page) => from(page.items)),
      toArray()
    );
  }
}
