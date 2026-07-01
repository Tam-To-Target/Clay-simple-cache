import { Router } from 'express';
import { profilesController } from './controllers/profiles.controller';
import { companiesController } from './controllers/companies.controller';
import { linkedinFinderController } from './controllers/linkedin-finder.controller';
import { dncController } from './controllers/dnc.controller';
import { hubspotController } from './controllers/hubspot.controller';
import { phoneburnerController } from './controllers/phoneburner.controller';
import { contactsController } from './controllers/contacts.controller';

import { docsController } from './controllers/docs.controller';
import { authMiddleware } from './middleware/auth.middleware';
import { requireIdentity } from './middleware/identity.middleware';

const router = Router();

router.get('/', (_req, res) => res.redirect('/docs/api'));

router.post('/profiles', authMiddleware, profilesController.upsert);
router.get('/profiles', authMiddleware, profilesController.get);

router.post('/companies', authMiddleware, companiesController.upsert);
router.get('/companies', authMiddleware, companiesController.get);

// LinkedIn Finder
router.post('/find-linkedin', authMiddleware, linkedinFinderController.find);

// Do Not Contact
router.post('/dnc-check', authMiddleware, dncController.check);

// DNC admin / management
router.post('/admin/clients', authMiddleware, dncController.upsertClient);
router.get('/admin/clients', authMiddleware, dncController.listClients);
router.get('/admin/clients/:external_id', authMiddleware, dncController.getClient);
router.post('/admin/dnc/sources', authMiddleware, dncController.upsertSource);
router.post('/admin/dnc/import', authMiddleware, dncController.importCsv);
router.post('/admin/dnc/sync', authMiddleware, dncController.sync);
router.post('/admin/dnc/discover', authMiddleware, dncController.discover);

// HubSpot contact push (create/update in the client's portal). If the portal
// isn't connected yet, the lead is stored 'pending' instead of erroring.
router.post('/admin/hubspot/contacts', authMiddleware, hubspotController.createContact);
// Replay stored ('pending'/'failed') leads into HubSpot once access is granted.
router.post('/admin/hubspot/backfill', authMiddleware, hubspotController.backfill);

// Contact ↔ customer associations + TAM-list building (Phase 3)
// Service-auth (API_KEY): associate a contact with a customer + reuse stats.
router.post('/admin/contacts/associate', authMiddleware, contactsController.associate);
router.get('/admin/contacts/reuse-stats', authMiddleware, contactsController.reuseStats);
// User-scoped (X-User-Token, introspected against GTMOS): build a customer's
// TAM list. The caller must have access to the customer in GTMOS.
router.get('/clients/:slug/contacts', requireIdentity, contactsController.buildList);

// PhoneBurner DNC purge (delete DNC-colliding contacts from members' books)
router.post('/admin/phoneburner/purge', authMiddleware, phoneburnerController.purge);

router.get('/docs/api', docsController.get);

export default router;
