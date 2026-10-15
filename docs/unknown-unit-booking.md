# Booking with unknown appliance details

The customer Core Services form now offers **I don’t know my unit details**, an unknown-brand checkbox, and unknown aircon type/HP options. Model numbers remain optional. This flow supports aircons, refrigerators and freezers.

Services with a fixed price can be booked when the customer does not know the brand or compressor HP. Services whose price depends on type or HP show **Price pending verification** and submit an unpaid identification request. A missing pricing value never falls back to a guessed tier or a zero-priced booking.

Identification requests cover one chosen service at a time. After staff confirms the appliance, customers can add other services using the identified details. Other services already in the booking remain intact. Identification requests reserve no schedule and create no payment.

Customers may include their model number, notes, and up to two JPG, PNG or WEBP photos, 5 MB each. Photos are stored in MongoDB GridFS and served only to their owner or authorized admin/secretary staff. The server checks file count, size, MIME type and image signature; unsuccessful request inserts clean up uploaded photos. Photos are optional because staff can contact customers using their account details.

Admin and secretary staff use the existing Unit identification queue. It now shows the appliance kind, model and photos, and prices compressor HP profiles as well as fixed-price profiles. Quote prices and work time come from the active service catalog. Customers must accept the quote before it can enter a paid booking. Expired, used, unaccepted, mismatched or changed quotes are rejected by the booking API.

The approved service returns to the booking with its appliance kind and assistance reference. Existing cart items and an unfinished appliance draft are preserved. Editing an approved service retains its assistance reference and prevents changes to the verified pricing details. Draft storage excludes photo files and image data; customers must reselect unsent photos after reloading. Retry references prevent a failed response or double-click from creating duplicate requests.

Cross-address relocations continue to require confirmed unit details and the existing separate relocation quote flow. Same-property relocation assistance retains its existing position validation.

Validation includes seven regression tests for appliance support, server field validation, pricing dependencies, quote eligibility, upload validation, photo access and rollback, plus isolated browser checks at 1440px, 390px and 320px. The browser checks exercise failed-request recovery, photo upload, staff verification, customer approval, return to booking and preservation of existing services and unfinished details. The full suite passed 1,982 tests across 273 files with zero failures.

Restart the backend and refresh the booking page to activate the updated routes and assets. No `.env` changes or data migration are required. Verification used mock records and did not create live requests, quotes or bookings.
