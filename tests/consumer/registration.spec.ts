import { test, expect } from '@playwright/test';

for (const registry of ['auto', 'global']) {
  test(`public packed registration, interaction and lazy readiness (${registry})`, async ({ page }) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort(); }
      return route.continue();
    });
    await page.goto(`/?registry=${registry}`);
    await expect(page.getByRole('status', { name: 'Package readiness' })).toHaveText(/^Ready: (scoped|global)$/);
    await page.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(page.getByLabel('Count')).toHaveText('1');
    await page.getByRole('button', { name: 'Load text field', exact: true }).click();
    await expect(page.getByRole('status', { name: 'Package readiness' })).toHaveText(/lazy field rendered/);
    const input = page.getByRole('textbox', { name: 'Consumer input' });
    await expect(input).toHaveValue('Packed source');
    await input.fill('Installed independently');
    await expect(input).toHaveValue('Installed independently');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}
