import type { ShoplifterTestHooks } from '../src/app/bootstrap.js';

declare global {
  interface Window {
    shoplifter?: ShoplifterTestHooks;
  }
}
