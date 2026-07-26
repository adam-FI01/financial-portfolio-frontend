import { Injectable, computed, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, tap, catchError, throwError } from 'rxjs';

import { API_BASE_URL } from '../config/api.config';
import { AuthResponse, ErrorResponse, LoginRequest, RegisterRequest } from '../models/auth.models';

interface JwtPayload {
  exp?: number;
  sub?: string;
  [key: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

function isTokenValid(token: string | null): boolean {
  if (!token) {
    return false;
  }
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) {
    return true;
  }
  return payload.exp * 1000 > Date.now();
}

/**
 * Token is kept in memory only (not localStorage/sessionStorage) as an interim
 * measure. It is lost on full page reload. A real httpOnly cookie requires the
 * backend to set it via Set-Cookie and read it in JwtAuthenticationFilter.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly token = signal<string | null>(null);

  readonly isAuthenticated = computed(() => isTokenValid(this.token()));

  constructor(private readonly http: HttpClient) {}

  login(request: LoginRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${API_BASE_URL}/auth/login`, request).pipe(
      tap((response) => this.token.set(response.token)),
      catchError((error: HttpErrorResponse) => throwError(() => this.toErrorResponse(error)))
    );
  }

  register(request: RegisterRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${API_BASE_URL}/auth/register`, request).pipe(
      tap((response) => this.token.set(response.token)),
      catchError((error: HttpErrorResponse) => throwError(() => this.toErrorResponse(error)))
    );
  }

  logout(): void {
    this.token.set(null);
  }

  getToken(): string | null {
    return this.token();
  }

  private toErrorResponse(error: HttpErrorResponse): ErrorResponse {
    if (error.error && typeof error.error === 'object' && 'message' in error.error) {
      return error.error as ErrorResponse;
    }
    return {
      timestamp: new Date().toISOString(),
      status: error.status,
      error: error.statusText,
      message: 'Unable to reach the server. Please try again.',
      path: error.url ?? '',
      fieldErrors: null
    };
  }
}
