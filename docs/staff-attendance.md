# Staff attendance

Administrators manage attendance at `/admin/staff/attendance`. Technicians and secretaries record their own attendance on their respective attendance pages. Technician check-in still requires the signed office QR, a registered device and fresh location evidence; secretary check-in uses the signed office QR.

## Dates and shifts

- Dates, shift deadlines and displayed times use Asia/Manila, independently of the server timezone.
- Daytime shifts retain the existing 9 AM late cutoff. A shift starting later than 9 AM uses its saved start time. The same rule drives scan status and missing-check-in reminders.
- An open shift continues under its original attendance date after midnight. Checkout, completed-worksite checks and expense confirmation use that shift's work window.
- An open shift from before yesterday requires admin review. It cannot silently accumulate new shifts or make the technician available indefinitely.
- Check-in, checkout and admin overrides share a lock for each staff member. Conditional updates and the existing unique staff/date indexes also protect against duplicate submissions.

## Closing a forgotten shift

1. Open **Staff → Attendance**. Today's roster also surfaces older open shifts, with their original work date.
2. Select **Close shift** on the affected row.
3. Enter the actual finish date/time in Philippine time and explain how it was verified.
4. Select **Record verified checkout**. A failed save keeps the entered time and reason so it can be retried.

The correction preserves the original work date, check-in and Present/Late status. It rejects a finish before check-in, a future finish, an invalid date or a record already changed by another request. The action is audited. General historical attendance editing remains disabled.

Existing records are never closed automatically. After an older shift is corrected, the staff member can refresh their attendance page and check in for a new day.

## Technician checkout

Active booking assignments and unsubmitted collections remain checkout blockers. If no expenses were recorded, the technician can either log actual expenses or confirm **No expenses this shift**, including after completing a booking. The confirmation is saved with attendance; it does not create an expense entry.

## Verification

Regression coverage includes role access, ownership, duplicate submissions, overnight checkout, lateness preservation, verified corrections, daylight/overnight shift cutoffs, and availability under UTC and Asia/Manila server timezones. Browser checks use synthetic records and simulated camera/GPS; they do not create real attendance or replace a physical device check.
