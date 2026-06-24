import { Profile as PrismaProfile, Company as PrismaCompany, Prisma } from '@prisma/client';

export type Profile = PrismaProfile;
export type Company = PrismaCompany;

export interface CreateProfileParams {
    email?: string | null;
    linkedin_slug?: string | null;
    linkedin_url?: string | null;
    phone_e164?: string | null;
    data?: Prisma.InputJsonValue;
}

export interface CreateCompanyParams {
    domain?: string | null;
    linkedin_slug?: string | null;
    data?: Prisma.InputJsonValue;
}

export interface ProfileResolution {
    status: 'ok' | 'error';
    resolved_by?: 'email' | 'linkedin_slug' | 'phone_e164' | 'new';
    profile_id?: string;
    profile?: Profile;
}

export interface CompanyResolution {
    status: 'ok' | 'error';
    resolved_by?: 'domain' | 'linkedin_slug' | 'new';
    company_id?: string;
    company?: Company;
}
