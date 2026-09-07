# Staff Archive and Retention Policy

Version 1.0

## Purpose

Staff accounts are archived rather than permanently deleted. This preserves the chain of responsibility for customer work, service reports, financial transactions, payroll, and security audits.

## Archive controls

- Only an authenticated administrator can archive or restore a staff member.
- A reason of 10–500 characters is required and written to the lifecycle and audit histories.
- A technician cannot be archived while linked to unfinished assignments, bookings, delivery or installation orders, or active projects. Those records must first be completed, cancelled, or reassigned.
- Archiving disables the login account, revokes its current session binding, removes the technician from active roster selection, and sets their availability to Offline.
- Restoring re-enables the account and roster record but leaves the technician Offline until normal availability or attendance flows update them.
- Permanent deletion is intentionally not exposed through the staff API or admin interface.

## Historical records

Archiving never cascades into operational or financial collections. Completed work, service reports, bookings, orders, projects, ratings, payroll, attendance, payments, and activity logs retain their original identifiers and snapshots.

The staff profile and historical business/audit records have no automatic purge job. They are retained while the system relies on them for operational, financial, warranty, dispute, or audit history. Email delivery logs remain subject to their existing 90-day TTL. Authentication sessions and trusted-device records retain their own security expiry rules.

Any future permanent-erasure process must be separately authorized, verify applicable legal/accounting requirements, and anonymize personal fields without breaking financial totals or audit integrity.

## Legacy inactive records

Records created before this policy may have `active: false` without archive metadata. The interface labels these as **Legacy Inactive** and allows an administrator to restore them. Once archived through the current workflow, the reason, actor, and timestamp are recorded.
