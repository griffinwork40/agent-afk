import '@testing-library/jest-dom';
import { beforeEach } from 'vitest';

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
});
