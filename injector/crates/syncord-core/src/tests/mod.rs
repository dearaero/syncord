//! Test modules for `syncord-core`.
//!
//! Split by module rather than in one file because the security-relevant cases
//! are numerous and grouping them by the module they attack makes it obvious
//! what is and is not covered.

mod access;
mod archive;
mod discovery;
mod inject;
mod parity;
mod policy;

mod release;
