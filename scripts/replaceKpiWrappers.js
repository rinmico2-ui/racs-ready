const fs = require('fs');
const path = require('path');

const adminDir = path.join(__dirname, '../server/views/pages/admin');

function walk(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            results = results.concat(walk(file));
        } else { 
            if (file.endsWith('.ejs')) results.push(file);
        }
    });
    return results;
}

const files = walk(adminDir);
let changedCount = 0;
files.forEach(f => {
    let content = fs.readFileSync(f, 'utf8');
    let original = content;

    // We want to replace exactly: <div class="col-auto"> ... <div class="kpi-card" 
    // AND <div class="col-md-3 d-flex"> ... <div class="kpi-card"
    // AND <div class="col-md-3"> ... <div class="kpi-card"
    
    // Using Regex:
    content = content.replace(
        /<div\s+class="(col-auto|col-md-3|col-md-3\s+d-flex)"([^>]*)>(\s*)<div([^>]*)class="([^"]*)kpi-card([^"]*)"/gi,
        '<div class="col-6 col-md-4 col-xl mb-3"$2>$3<div$4class="$5kpi-card$6"'
    );

    if (content !== original) {
        fs.writeFileSync(f, content, 'utf8');
        console.log('Updated:', path.relative(__dirname, f).replace(/\\/g, '/'));
        changedCount++;
    }
});
console.log(`Done! Updated ${changedCount} files.`);