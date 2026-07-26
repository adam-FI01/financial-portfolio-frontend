import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { API_BASE_URL } from '../config/api.config';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const token = authService.getToken();

  const isApiRequest = req.url.startsWith(API_BASE_URL);
  const isAuthEndpoint = req.url.startsWith(`${API_BASE_URL}/auth/`);

  if (token && isApiRequest) {
    req = req.clone({
      setHeaders: { Authorization: `Bearer ${token}` }
    });
  }

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      // A 401 from /auth/login or /auth/register just means bad credentials —
      // only treat 401s from other API calls as an expired/invalid session.
      if (isApiRequest && !isAuthEndpoint && error.status === 401) {
        authService.logout();
        router.navigateByUrl('/login');
      }
      return throwError(() => error);
    })
  );
};
