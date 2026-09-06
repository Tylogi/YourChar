import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { launch } from 'cloakbrowser';

// Run from the repository root with the browser library environment used by test:browser.
const preview = new URL('../ui-social-modern.html', import.meta.url);
const html = await readFile(preview, 'utf8');
new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
assert(!/linear-gradient|backdrop-filter:blur|font-size:[89]px/.test(html));
const output = await mkdtemp(join(tmpdir(), 'yourchar-neutral-ui-'));
const browser = await launch({ headless: true });
const errors = [];
const network = [];

function luminance(rgb) {
  const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
    const c = n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

async function verifyContrast(page) {
  const pairs = await page.evaluate(() => {
    return [
      ['.bubble', '.bubble'],
      ['.message.outgoing .bubble', '.message.outgoing .bubble'],
      ['.send', '.send'],
      ['.session.active .session-title strong', '.session.active'],
      ['.session.active .session-title time', '.session.active'],
      ['.session-preview', '.session.active'],
      ['.badge', '.badge'],
      ['.nav-button.active', '.nav-button.active'],
      ['.thread-heading p', '.thread-header'],
      ['.place-bottom button', '.place-card'],
    ].map(([fg, bg]) => ({
      selector: fg,
      foreground: getComputedStyle(document.querySelector(fg)).color,
      background: getComputedStyle(document.querySelector(bg)).backgroundColor,
    }));
  });
  for (const pair of pairs) {
    const a = luminance(pair.foreground);
    const b = luminance(pair.background);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert(contrast >= 4.5, `${pair.selector}: contrast ${contrast.toFixed(2)}`);
  }
}

async function checkGeometry(page) {
  const result = await page.evaluate(() => {
    const visible = element => element.getClientRects().length > 0;
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      bubbles: [...document.querySelectorAll('.bubble')].filter(visible).map(element => ({
        size: getComputedStyle(element).fontSize,
        overflow: element.scrollWidth > element.clientWidth + 1,
      })),
    };
  });
  assert.equal(result.overflow, false, 'Horizontal page overflow');
  for (const bubble of result.bubbles) {
    assert.equal(bubble.size, '16px');
    assert.equal(bubble.overflow, false, 'Horizontal message overflow');
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.goto(preview.href);
  await page.evaluate(async () => {
    localStorage.removeItem('yourchar-social-theme');
    document.body.classList.remove('dark');
    const portrait = new Image();
    portrait.src = 'ui-social-assets/avatars.png';
    await portrait.decode();
    await document.fonts.ready;
  });
  assert.equal(await page.locator('.bubble').first().evaluate(e => getComputedStyle(e).fontFamily.includes('system-ui')), true);
  assert.equal(await page.locator('#more .icon').evaluate(e => getComputedStyle(e).strokeWidth), '1.75px');
  assert.equal(await page.locator('.nav-button.active .icon').evaluate(e => getComputedStyle(e).strokeWidth), '2.1px');
  await checkGeometry(page);
  await verifyContrast(page);
  await page.screenshot({ path: join(output, 'desktop.png') });

  const avatarImage = await page.locator('#header-avatar').evaluate(e => getComputedStyle(e).backgroundImage);
  assert.notEqual(avatarImage, 'none');
  await page.locator('#header-avatar').hover();
  assert.equal(await page.locator('#header-avatar').evaluate(e => getComputedStyle(e).backgroundImage), avatarImage);
  await page.locator('#header-avatar').click();
  assert(await page.locator('#drawer').isVisible());
  await page.screenshot({ path: join(output, 'profile.png') });
  await page.locator('#close-drawer').click();
  await page.locator('.inline-task summary').click();
  assert(await page.locator('.inline-task').evaluate(e => e.open));
  await page.locator('#input').fill('<hello> 中文消息');
  await page.locator('#input').press('Enter');
  assert(await page.locator('.bubble').filter({ hasText: '<hello> 中文消息' }).isVisible());
  assert.equal(await page.locator('.bubble hello').count(), 0);
  await page.locator('.session[data-contact=su]').click();
  assert.equal(await page.locator('.session[data-contact=su] .badge').count(), 0);
  await page.locator('.session[data-contact=lin]').click();
  assert.equal(await page.locator('.bubble').filter({ hasText: '<hello> 中文消息' }).count(), 1);
  await page.locator('#emoji').click();
  await page.locator('[data-emoji="😊"]').click();
  assert.equal(await page.locator('#input').inputValue(), '😊');
  await page.locator('#input').fill('');
  await page.locator('[data-enter-world]').first().click();
  assert.equal(await page.locator('#header-name').textContent(), '青岚市');
  await page.screenshot({ path: join(output, 'world.png') });
  for (const section of ['people', 'calendar', 'management', 'settings']) {
    await page.locator(`.rail [data-page=${section}]`).click();
    assert(await page.locator('#page').isVisible());
  }

  await page.locator('.rail [data-page=chat]').click();
  await page.locator('.session[data-contact=lin]').click();
  await page.locator('.rail [data-action=theme]').click();
  await page.reload();
  assert(await page.locator('body').evaluate(e => e.classList.contains('dark')));
  await verifyContrast(page);
  await page.screenshot({ path: join(output, 'dark.png') });
  await page.locator('.rail [data-action=theme]').click();

  for (const width of [1920, 1280, 1024, 768, 620, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    if (width <= 620) {
      assert(await page.locator('.contacts').isVisible());
      await page.locator('.session[data-contact=lin]').click();
    }
    await checkGeometry(page);
    assert(await page.locator('.send').isVisible());
    const bounds = await page.locator('.send').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.screenshot({ path: join(output, 'mobile-list.png') });
  await page.locator('.session[data-contact=lin]').click();
  await page.screenshot({ path: join(output, 'mobile-chat.png') });
  await page.locator('#back').click();
  assert(await page.locator('.contacts').isVisible());
  await page.locator('.session[data-contact=world]').click();
  assert.equal(await page.locator('#header-name').textContent(), '青岚市');
  await checkGeometry(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  console.log('PASS: neutral light/dark palettes, representative text contrast >= 4.5:1, 16px messages, native font stack, SVG icons, portrait loading, profile/world/chat flows, theme persistence, and 320–1920px responsive layouts. No JS errors or external asset requests.');
  console.log(`Screenshots: ${output}`);
} finally {
  await browser.close();
}
