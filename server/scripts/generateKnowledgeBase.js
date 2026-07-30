const fs = require("fs");
const path = require("path");

const KNOWLEDGE_BASE = path.join(__dirname, "../knowledge_base");
const TEMPLATE_DIR = path.join(__dirname, "templates");

function loadTemplate(name) {
    const file = path.join(TEMPLATE_DIR, name);

    if (!fs.existsSync(file)) {
        console.warn(`Template missing: ${name}`);
        return "";
    }

    return fs.readFileSync(file, "utf8");
}

function titleCase(filename) {
    return filename
        .replace(".md", "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
}

function detectTemplate(filename) {

    filename = filename.toLowerCase();

    if (
        filename.includes("failure") ||
        filename.includes("refrigerant") ||
        filename.includes("thermostat") ||
        filename.includes("fault") ||
        filename.includes("water-leak") ||
        filename.includes("frozen") ||
        filename.includes("filter")
    ) {
        return "diagnostic.md";
    }

    if (filename === "brands.md")
        return "brands.md";

    if (filename === "parts.md")
        return "parts.md";

    if (filename === "inspection_checklist.md")
        return "inspection.md";

    if (filename === "repair_flow.md")
        return "repair.md";

    if (filename === "maintenance.md")
        return "maintenance.md";

    if (filename === "safety.md")
        return "safety.md";

    if (filename === "tools.md")
        return "tools.md";

    if (filename === "common_errors.md")
        return "common_errors.md";

    if (filename === "error_codes.md")
        return "error_codes.md";

    if (filename === "symptoms.md")
        return "symptoms.md";

    return null;
}

function processDirectory(dir) {

    const items = fs.readdirSync(dir);

    for (const item of items) {

        const full = path.join(dir, item);

        const stat = fs.statSync(full);

        if (stat.isDirectory()) {
            processDirectory(full);
            continue;
        }

        if (!item.endsWith(".md"))
            continue;

        const existing = fs.readFileSync(full, "utf8").trim();

        if (existing.length > 0) {
            console.log(`Skipped ${item}`);
            continue;
        }

        const template = detectTemplate(item);

        if (!template) {
            console.log(`No template for ${item}`);
            continue;
        }

        let content = loadTemplate(template);

        content = content.replaceAll("{{TITLE}}", titleCase(item));

        fs.writeFileSync(full, content);

        console.log(`Generated ${item}`);

    }

}

processDirectory(KNOWLEDGE_BASE);

console.log("\nFinished generating templates.");