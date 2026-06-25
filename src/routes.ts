import { Router } from 'express';
import { profilesController } from './controllers/profiles.controller';
import { companiesController } from './controllers/companies.controller';
import { linkedinFinderController } from './controllers/linkedin-finder.controller';
import { dncController } from './controllers/dnc.controller';
import { hubspotController } from './controllers/hubspot.controller';

import { docsController } from './controllers/docs.controller';
import { authMiddleware } from './middleware/auth.middleware';

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
router.get('/admin/clients/:external_id', authMiddleware, dncController.getClient);
router.post('/admin/dnc/sources', authMiddleware, dncController.upsertSource);
router.post('/admin/dnc/import', authMiddleware, dncController.importCsv);
router.post('/admin/dnc/sync', authMiddleware, dncController.sync);
router.post('/admin/dnc/discover', authMiddleware, dncController.discover);

// HubSpot contact push (create/update in the client's portal)
router.post('/admin/hubspot/contacts', authMiddleware, hubspotController.createContact);

router.get('/docs/api', docsController.get);

export default router;
