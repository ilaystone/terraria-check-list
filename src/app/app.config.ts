import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `withComponentInputBinding` lets a route parameter arrive as a component
    // `input()`, which keeps the detail page reactive without injecting ActivatedRoute.
    provideRouter(routes, withComponentInputBinding()),
  ],
};
