import { Router } from "express";
import { prisma } from "../../config/prisma.js";
import { recordActivity } from "../../services/activity/activityService.js";
import { storageService } from "../../services/storage/index.js";
import { formatSetting } from "./tenant.helpers.js";

const router = Router();

/**
 * GET /api/v1/tenant/settings
 */
router.get('/settings', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const setting = await prisma.setting.findFirst({
      where: { tenantId }
    });

    const settingData = formatSetting(setting) || {};
    res.status(200).json({
      status: 'success',
      data: {
        ...settingData,
        business_type: req.tenantUser?.business_type || 'SALES_AND_RENTAL',
        businessType: req.tenantUser?.business_type || 'SALES_AND_RENTAL'
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/tenant/settings
 */
router.put('/settings', async (req, res, next) => {
  try {
    const tenantId = req.tenantId;
    const {
      company_name,
      page_title,
      logo_url,
      bill_show_logo,
      phone_number,
      address,
      gst_number,
      currency,
      upi_id,
      whatsapp_url,
      instagram_link,
      facebook_url,
      tax_rate,
      rental_day_calculation_mode,
      terms_and_conditions
    } = req.body;

    const existing = await prisma.setting.findFirst({
      where: { tenantId }
    });

    let updated;
    if (existing) {
      // Automatically delete previous logo from storage if replaced with a different URL
      if (logo_url !== undefined && logo_url !== existing.logoUrl && existing.logoUrl) {
        storageService.delete(existing.logoUrl).catch((err) => {
          console.warn(`[Settings] Failed to delete replaced logo: ${existing.logoUrl}`, err.message);
        });
      }

      updated = await prisma.setting.update({
        where: { id: existing.id },
        data: {
          companyName: company_name !== undefined ? company_name : undefined,
          pageTitle: page_title !== undefined ? page_title : undefined,
          logoUrl: logo_url !== undefined ? logo_url : undefined,
          billShowLogo: bill_show_logo !== undefined ? Boolean(bill_show_logo) : undefined,
          phoneNumber: phone_number !== undefined ? phone_number : undefined,
          address: address !== undefined ? address : undefined,
          gstNumber: gst_number !== undefined ? gst_number : undefined,
          currency: currency !== undefined ? currency : undefined,
          upiId: upi_id !== undefined ? upi_id : undefined,
          whatsappUrl: whatsapp_url !== undefined ? whatsapp_url : undefined,
          instagramLink: instagram_link !== undefined ? instagram_link : undefined,
          facebookUrl: facebook_url !== undefined ? facebook_url : undefined,
          taxRate: tax_rate !== undefined ? Number(tax_rate) : undefined,
          rentalDayCalculationMode: rental_day_calculation_mode !== undefined ? rental_day_calculation_mode : undefined,
          termsAndConditions: terms_and_conditions !== undefined ? terms_and_conditions : undefined,
          updatedAt: new Date()
        }
      });
    } else {
      updated = await prisma.setting.create({
        data: {
          tenantId,
          companyName: company_name || '',
          pageTitle: page_title || '',
          logoUrl: logo_url || '',
          billShowLogo: bill_show_logo !== undefined ? Boolean(bill_show_logo) : true,
          phoneNumber: phone_number || '',
          address: address || '',
          gstNumber: gst_number || '',
          currency: currency || 'INR',
          upiId: upi_id || '',
          whatsappUrl: whatsapp_url || '',
          instagramLink: instagram_link || '',
          facebookUrl: facebook_url || '',
          taxRate: tax_rate !== undefined ? Number(tax_rate) : 0,
          rentalDayCalculationMode: rental_day_calculation_mode || 'DIFF_2_DAYS',
          termsAndConditions: terms_and_conditions || ''
        }
      });
    }

    recordActivity({
      tenantId,
      action: 'update',
      entityType: 'settings',
      entityId: updated.id,
      summary: `Updated shop settings (${updated.companyName || 'profile'})`,
      changes: {
        company_name: updated.companyName,
        phone_number: updated.phoneNumber,
        gst_number: updated.gstNumber,
        upi_id: updated.upiId,
        bill_show_logo: updated.billShowLogo
      },
      req
    });

    res.status(200).json({ status: 'success', data: formatSetting(updated) });
  } catch (error) {
    next(error);
  }
});

export default router;
