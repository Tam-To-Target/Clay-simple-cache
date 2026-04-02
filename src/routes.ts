import { Router } from 'express';
import { profilesController } from './controllers/profiles.controller';
import { companiesController } from './controllers/companies.controller';
import { emailFinderController } from './controllers/email-finder.controller';

import { docsController } from './controllers/docs.controller';
import { authMiddleware } from './middleware/auth.middleware';

const router = Router();

router.get('/', (_req, res) => res.redirect('/docs/api'));

router.post('/profiles', authMiddleware, profilesController.upsert);
router.get('/profiles', authMiddleware, profilesController.get);

router.post('/companies', authMiddleware, companiesController.upsert);
router.get('/companies', authMiddleware, companiesController.get);

// Email Finder
router.post('/find', authMiddleware, emailFinderController.find);
router.post('/verify', authMiddleware, emailFinderController.verify);
router.get('/stats', authMiddleware, emailFinderController.stats);

router.get('/docs/api', docsController.get);

export default router;
