# Staff archive and restore

The archive and restore endpoints previously validated the entire User and
Technician documents before saving. A historical phone such as `0917-123-4567`
fails the current digits-only account validator and caused an internal server
error even though archiving does not change the phone number.

Lifecycle writes now use validated field updates. They set account availability,
archive metadata, session revocation and lifecycle history without rewriting
contact details, passwords or other operational records. Linked User and
Technician changes use the existing workflow writer: a transaction when supported,
or version-guarded writes with conditional reversal on standalone MongoDB. A
conflicting update returns a staff-specific refresh message. Repeating an archive
or restore repairs a previously inconsistent pair of linked records.

The unfinished-work preflight includes pending and accepted supporting technicians
on standard bookings and order installations. Completed parent bookings do not
block archiving because of an outdated nested service status. Historical work,
payroll and audit data remain retained.

Regression tests execute the actual controller and Mongoose query casting and
update validators, replacing only database I/O and audit delivery with synthetic
fixtures. Coverage includes legacy accounts, secretary and technician profiles,
restore, required reasons, unfinished-work conflicts, idempotency, partial failure
reversal, optimistic concurrency and replica-set transaction propagation. No live
staff account is changed by these checks.
