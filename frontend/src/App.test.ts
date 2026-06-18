import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import App from './App.svelte';

describe('App', () => {
  it('renders the mailhedgehog header', () => {
    render(App);
    expect(screen.getByRole('heading', { name: 'mailhedgehog' })).toBeTruthy();
  });
});
