import type { FilmLabApi } from '../shared/types';

declare global {
  interface Window {
    filmLab: FilmLabApi;
  }
}

export {};
