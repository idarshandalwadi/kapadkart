import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/prisma.js';

export async function ensureTestTenant() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'khodal-mahakali-shop' },
    update: { status: 'active' },
    create: {
      slug: 'khodal-mahakali-shop',
      name: 'khodal-mahakali-shop',
      businessType: 'SALES_AND_RENTAL',
      status: 'active'
    }
  });

  try {
    await prisma.setting.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        companyName: 'khodal-mahakali-shop',
        pageTitle: 'khodal-mahakali-shop',
        phoneNumber: '7227807493'
      }
    });
  } catch (err) {
    if (err.code !== 'P2002') throw err;
  }

  const hash = await bcrypt.hash('Khodal@123', 10);
  try {
    await prisma.user.upsert({
      where: {
        tenantId_email: {
          tenantId: tenant.id,
          email: 'khodal@kapadkart.com'
        }
      },
      update: { passwordHash: hash },
      create: {
        tenantId: tenant.id,
        email: 'khodal@kapadkart.com',
        passwordHash: hash,
        fullName: 'mahakali'
      }
    });
  } catch (err) {
    if (err.code !== 'P2002') throw err;
  }

  return tenant.id;
}
