const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scriptPath = path.join(__dirname, "../public/js/enterprise-alerts.js");
const stylePath = path.join(__dirname, "../public/css/enterprise-alerts.css");

function installEnterpriseAlerts(document) {
  let capturedOptions;
  const Swal = {
    fire(options) {
      capturedOptions = options;
      return Promise.resolve({ isConfirmed: true });
    },
  };
  const context = { window: { Swal, document } };
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), context);
  return { Swal, getOptions: () => capturedOptions };
}

test("enterprise SweetAlert adapter preserves shorthand calls and adds semantic styling", async () => {
  const { Swal, getOptions } = installEnterpriseAlerts();
  await Swal.fire("Delete record?", "This action cannot be undone.", "warning");
  const options = getOptions();

  assert.equal(options.title, "Delete record?");
  assert.equal(options.text, "This action cannot be undone.");
  assert.equal(options.icon, "warning");
  assert.match(options.customClass.popup, /racs-enterprise-alert/);
  assert.match(options.customClass.popup, /racs-enterprise-warning/);
  assert.equal(options.heightAuto, false);
});

test("enterprise SweetAlert adapter protects form dialogs and destructive confirmations", async () => {
  const { Swal, getOptions } = installEnterpriseAlerts();
  let opened = false;
  await Swal.fire({
    title: "Remove access?",
    input: "text",
    showCancelButton: true,
    confirmButtonText: "Remove",
    didOpen(popup) {
      opened = popup.enterprise === true;
    },
  });
  const options = getOptions();
  const popup = { enterprise: true, setAttribute(name, value) { this[name] = value; } };
  options.didOpen(popup);

  assert.equal(options.allowOutsideClick, false);
  assert.match(options.customClass.confirmButton, /racs-enterprise-danger/);
  assert.equal(popup["data-enterprise-dialog"], "true");
  assert.equal(opened, true);
});

test("enterprise alerts render inside and above an active application modal", async () => {
  const activeModal = {
    closest() { return null; },
  };
  const document = {
    querySelectorAll(selector) {
      return selector === ".modal.show" ? [activeModal] : [];
    },
  };
  const { Swal, getOptions } = installEnterpriseAlerts(document);

  await Swal.fire({ title: "Missing selection", icon: "warning" });
  const options = getOptions();

  assert.equal(options.target, activeModal);
  assert.match(options.customClass.container, /racs-enterprise-over-modal/);
});

test("all interactive application layouts load the shared enterprise alert assets", () => {
  for (const layoutName of ["admin.ejs", "secretary.ejs", "technician.ejs", "main.ejs", "auth.ejs"]) {
    const layout = fs.readFileSync(path.join(__dirname, "../views/layouts", layoutName), "utf8");
    assert.match(layout, /\/css\/enterprise-alerts\.css/, layoutName);
    assert.match(layout, /\/js\/enterprise-alerts\.js/, layoutName);
  }

  const css = fs.readFileSync(stylePath, "utf8");
  assert.match(css, /\.swal2-popup:not\(\.swal2-toast\)/);
  assert.match(css, /#globalConfirmModal \.modal-content/);
  assert.match(css, /\.racs-enterprise-danger/);
  assert.match(css, /\.swal2-actions \{[\s\S]*?justify-content: center !important;/);
  assert.match(css, /z-index: 2147483000 !important;/);
  assert.match(css, /@media \(max-width: 575\.98px\)/);
});
