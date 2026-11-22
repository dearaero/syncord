-- Retire only desktop administration authority; preserve user sessions and audit history.
UPDATE supporter_admin_sessions SET revoked=1 WHERE revoked=0;
UPDATE challenges SET consumed=1,verified_id=NULL,verifier='',browser_hash=NULL,failure='supporter.adminWebOnly' WHERE purpose='supporter-admin';
