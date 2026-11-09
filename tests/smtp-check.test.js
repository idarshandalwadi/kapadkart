import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkSmtpConnection, smtpProviderLabel } from '../src/services/email/emailService.js';
import { disconnectPrisma } from '../src/config/prisma.js';

after(async () => {
  await disconnectPrisma();
});

describe('SMTP connection check', () => {
  it('names the provider from the SMTP host', () => {
    assert.equal(smtpProviderLabel('smtp.gmail.com'), 'Gmail');
    assert.equal(smtpProviderLabel('email-smtp.ap-south-1.amazonaws.com'), 'Amazon SES');
    assert.equal(smtpProviderLabel('mail.example.com'), 'Custom SMTP');
  });

  it('reports missing credentials without opening a connection', async () => {
    const result = await checkSmtpConnection({ user: '', pass: '' });
    assert.equal(result.configured, false);
    assert.equal(result.connected, false);
    assert.equal(result.status, 'degraded');
    assert.equal(result.provider, null);
    assert.match(result.error, /not configured/i);
  });
});
