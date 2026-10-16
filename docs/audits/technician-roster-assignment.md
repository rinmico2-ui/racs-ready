# Technician roster and assignment consistency

Staff List remains the source of staff identity and account status. The technician
directory and the booking/order assignment planners now use one roster reader.
For linked profiles it takes name, email, phone, active/archive state and sign-in
readiness from User. Technician keeps its existing operational ID, schedules,
location, ratings and work history. No assignment or historical ID is migrated.

The technician directory requests the complete roster, including inactive and
archived accounts and accounts without a work profile. Its status filters work
on those account states; archiving uses the Staff List ID. Missing profiles have
an admin-only "Set up work profile" action. The action creates a profile for that
exact User ID with a unique, idempotent upsert. It does not guess matches by name
or email, alter an existing profile, send invitations or enable an account.

Manual booking/order crew selection, AI/bulk planning, legacy eligible-technician
endpoints and delivery assignment use the shared roster. Archived, inactive,
blocked, invited/unverified accounts and profiles without a sign-in account
cannot receive new assignments. A deleted account or a changed non-technician
role cannot reappear as an available technician. User status takes precedence
over stale profile flags, matching Staff List.

Both AI planners use the same existing company schedule fallback as the manual
picker when no custom schedule exists. A saved custom schedule still wins.
Assigning an existing future appointment checks capacity without applying the
minimum advance notice for a *new* customer booking. Only a trusted internal
call with a job exclusion can select that mode; HTTP query parameters cannot.
Leave, overlapping work, travel/buffer capacity, team acceptance, payment and
past-appointment restrictions remain enforced.

The regression checks use synthetic records and actual controllers, roster
merging, planners and scheduling handlers. They do not modify live staff or jobs.
