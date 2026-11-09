import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_SHOP_APP_URL,
  PRODUCTION_SHOP_APP_URL,
  resolveShopAppUrl,
  shopEmailLinks
} from '../src/services/email/appLinks.js';
import { buildWelcomeShopHtml, buildAccountSuspendedHtml } from '../src/services/email/emailService.js';

describe('email shop links', () => {
  it('uses localhost when the API request is local', () => {
    const base = resolveShopAppUrl({
      nodeEnv: 'development',
      requestHost: 'localhost:4000'
    });
    const links = shopEmailLinks(base);

    assert.equal(base, LOCAL_SHOP_APP_URL);
    assert.equal(links.loginUrl, 'http://localhost:5173/login');
    assert.equal(links.supportUrl, 'http://localhost:5173/contact');
  });

  it('uses the live shop app when the API request is public', () => {
    const base = resolveShopAppUrl({
      nodeEnv: 'development',
      requestHost: 'kapadkart-admin.pages.dev,13.234.170.148.sslip.io'
    });

    assert.equal(base, PRODUCTION_SHOP_APP_URL);
    assert.equal(shopEmailLinks(base).loginUrl, 'https://kapadkart.pages.dev/login');
  });

  it('keeps a local request on localhost even when NODE_ENV is production', () => {
    assert.equal(
      resolveShopAppUrl({ nodeEnv: 'production', requestHost: '127.0.0.1:4000' }),
      LOCAL_SHOP_APP_URL
    );
  });

  it('uses the live shop app for production sends that have no request host', () => {
    assert.equal(
      resolveShopAppUrl({ nodeEnv: 'production' }),
      PRODUCTION_SHOP_APP_URL
    );
  });

  it('lets SHOP_APP_URL override both local and production defaults', () => {
    assert.equal(
      resolveShopAppUrl({
        nodeEnv: 'production',
        configured: 'https://shop.example.com/',
        requestHost: 'localhost:4000'
      }),
      'https://shop.example.com'
    );
  });

  it('puts the resolved dashboard URL on the welcome email button', () => {
    const html = buildWelcomeShopHtml({
      shopName: 'Khodal',
      slug: 'khodal',
      ownerEmail: 'owner@example.com',
      temporaryPassword: 'secret',
      loginUrl: 'https://kapadkart.pages.dev/login'
    });

    assert.match(html, /href="https:\/\/kapadkart\.pages\.dev\/login"/);
    assert.doesNotMatch(html, /localhost/);
  });

  it('puts the resolved support URL on the suspension email', () => {
    const html = buildAccountSuspendedHtml({
      shopName: 'Khodal',
      ownerName: 'Owner',
      supportUrl: 'https://kapadkart.pages.dev/contact'
    });

    assert.match(html, /href="https:\/\/kapadkart\.pages\.dev\/contact"/);
    assert.doesNotMatch(html, /localhost/);
  });
});
