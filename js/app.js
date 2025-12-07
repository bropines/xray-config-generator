/* STATE */
let loadedConfig = { routing: { rules: [] }, outbounds: [] };
let geoSiteData = null;
let geoIpData = null;
let currentRuleIndex = -1;

/* DOM ELEMENTS */
const rulesContainer = document.getElementById('rulesListContainer');
const editorForm = document.getElementById('editorForm');
const emptyState = document.getElementById('emptyState');
const outboundSuggestions = document.getElementById('outboundSuggestions');
const themeBtn = document.getElementById('themeToggle');

/* INITIALIZATION */
initTheme();
setupFileUploads();
setupEditorButtons();

// --- THEME HANDLING ---
function initTheme() {
    const theme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    themeBtn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
}

// --- FILE UPLOADS ---
function setupFileUploads() {
    const reader = (file, callback) => {
        const r = new FileReader();
        r.onload = e => callback(e.target.result);
        r.readAsArrayBuffer(file);
    };

    // Config JSON
    document.getElementById('fileConfig').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if(!file) return;
        const text = await file.text();
        try {
            loadedConfig = JSON.parse(text);
            if(!loadedConfig.routing) loadedConfig.routing = { rules: [] };
            if(!loadedConfig.routing.rules) loadedConfig.routing.rules = [];
            
            document.getElementById('statusConfig').classList.add('active');
            renderRulesList();
            renderOutboundTags();
            showEmptyState();
        } catch(err) { alert("Error parsing Config JSON: " + err.message); }
    });

    // GeoSite
    document.getElementById('fileGeoSite').addEventListener('change', (e) => {
        if(e.target.files[0]) {
            reader(e.target.files[0], (data) => parseProto(data, 'geosite', (res) => {
                geoSiteData = res;
                document.getElementById('statusGeoSite').classList.add('active');
            }));
        }
    });

    // GeoIP
    document.getElementById('fileGeoIP').addEventListener('change', (e) => {
        if(e.target.files[0]) {
            reader(e.target.files[0], (data) => parseProto(data, 'geoip', (res) => {
                geoIpData = res;
                document.getElementById('statusGeoIP').classList.add('active');
            }));
        }
    });
}

// --- PROTOBUF WORKER LOGIC ---
function parseProto(buffer, type, callback) {
    // FIX: Абсолютный путь
    const relativePath = type === 'geosite' ? 'public/geosite.proto' : 'public/geoip.proto';
    const absoluteProtoUrl = new URL(relativePath, window.location.href).href;

    const workerCode = `
        importScripts('https://unpkg.com/protobufjs/dist/protobuf.min.js');
        self.onmessage = async (e) => {
            const { buffer, type, protoUrl } = e.data;
            try {
                const protoContent = await (await fetch(protoUrl)).text();
                const root = (await protobuf.parse(protoContent)).root;
                const Type = root.lookupType(type === 'geosite' ? 'GeoSiteList' : 'GeoIPList');
                const msg = Type.decode(new Uint8Array(buffer));
                
                // FIX: Сохраняем домены для GeoSite, чтобы работал поиск по содержимому
                const list = msg.entry.map(e => {
                    if (type === 'geosite') {
                        return {
                            code: e.countryCode,
                            // Сохраняем массив доменов (строки) для поиска
                            domains: (e.domain || []).map(d => d.value) 
                        };
                    } else {
                        return {
                            code: e.countryCode,
                            count: e.cidr?.length || 0
                        };
                    }
                });
                self.postMessage({ success: true, data: list });
            } catch(err) { 
                self.postMessage({ success: false, err: err.message }); 
            }
        };
    `;
    const blob = new Blob([workerCode], {type: 'application/javascript'});
    const worker = new Worker(URL.createObjectURL(blob));
    
    worker.onmessage = (e) => {
        if(e.data.success) callback(e.data.data);
        else console.error("Worker Error:", e.data.err);
        worker.terminate();
    };

    worker.postMessage({ buffer, type, protoUrl: absoluteProtoUrl }, [buffer]);
}

// --- TAG INPUT CLASS (Chips & Autocomplete) ---
class TagInput {
    constructor(containerId, inputId, listId = null, onUpdate = null) {
        this.container = document.getElementById(containerId);
        this.input = document.getElementById(inputId);
        this.list = listId ? document.getElementById(listId) : null;
        this.tags = [];
        this.onUpdate = onUpdate;
        this.debounce = null;

        this.init();
    }

    init() {
        this.container.addEventListener('click', () => this.input.focus());
        
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addTag(this.input.value);
            } else if (e.key === 'Backspace' && this.input.value === '' && this.tags.length > 0) {
                this.removeTag(this.tags.length - 1);
            }
        });

        if (this.list) {
            this.input.addEventListener('input', () => {
                clearTimeout(this.debounce);
                this.debounce = setTimeout(() => this.handleAutocomplete(), 300);
            });
            this.input.addEventListener('blur', () => setTimeout(() => this.list.classList.add('hidden'), 200));
        }
    }

    setTags(newTags) {
        this.tags = [];
        this.container.querySelectorAll('.tag-chip').forEach(el => el.remove());
        newTags.forEach(t => this.createChip(t));
        this.tags = [...newTags];
    }

    addTag(val) {
        const clean = val.trim();
        if (!clean || this.tags.includes(clean)) {
            this.input.value = ''; 
            return;
        }
        
        this.createChip(clean);
        this.tags.push(clean);
        this.input.value = '';
        if(this.list) this.list.classList.add('hidden');
        if(this.onUpdate) this.onUpdate();
    }

    createChip(val) {
        const chip = document.createElement('div');
        chip.className = 'tag-chip';
        
        if(val.startsWith('geoip:') || /^[\d\.:\/]+$/.test(val)) chip.classList.add('ip-chip');
        else chip.classList.add('domain-chip');

        chip.innerHTML = `<span>${val}</span><span class="tag-remove">&times;</span>`;
        
        chip.querySelector('.tag-remove').addEventListener('click', (e) => {
            e.stopPropagation(); 
            const idx = this.tags.indexOf(val);
            if(idx > -1) this.removeTag(idx);
        });

        this.container.insertBefore(chip, this.input);
    }

    removeTag(index) {
        this.tags.splice(index, 1);
        this.container.querySelectorAll('.tag-chip')[index].remove();
        if(this.onUpdate) this.onUpdate();
    }

    handleAutocomplete() {
        const q = this.input.value.toLowerCase();
        if (q.length < 2) {
            this.list.classList.add('hidden');
            return;
        }

        const results = [];
        
        // --- SEARCH LOGIC ---
        
        // 1. Search GeoSites
        if (geoSiteData) {
            for (const item of geoSiteData) {
                // A. Check Category Name (e.g. "google")
                if (item.code.toLowerCase().includes(q)) {
                    results.push({ 
                        val: `geosite:${item.code}`, 
                        desc: `${item.domains ? item.domains.length : 0} domains`, 
                        type: 'GeoSite' 
                    });
                }
                // B. Check Content (Deep Search for "aistudio")
                // Only if query is specific enough (> 2 chars) to avoid lag
                else if (item.domains && q.length > 2) {
                    const match = item.domains.find(d => d.toLowerCase().includes(q));
                    if (match) {
                        results.push({
                            val: `geosite:${item.code}`, // We suggest the CATEGORY
                            desc: `Contains "${match}"`,   // We explain WHY
                            type: 'GeoSite'
                        });
                    }
                }
                if (results.length > 8) break; // Limit GeoSite results
            }
        }

        // 2. Search GeoIPs (Only by category name usually)
        if (geoIpData) {
            let count = 0;
            for (const item of geoIpData) {
                if (item.code.toLowerCase().includes(q)) {
                    results.push({ 
                        val: `geoip:${item.code}`, 
                        desc: `${item.count} ranges`, 
                        type: 'GeoIP' 
                    });
                    count++;
                }
                if (count > 4) break;
            }
        }

        if (results.length === 0) {
            this.list.classList.add('hidden');
            return;
        }

        this.list.innerHTML = '';
        results.forEach(res => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `
                <div>
                    <div class="sugg-value">${res.val}</div>
                    <div class="sugg-desc">${res.desc}</div>
                </div>
                <div class="sugg-badge">${res.type}</div>
            `;
            // mousedown fires before blur, allowing click to register
            div.addEventListener('mousedown', () => this.addTag(res.val)); 
            this.list.appendChild(div);
        });
        this.list.classList.remove('hidden');
    }
}

/* INSTANCES */
const mainTagInput = new TagInput('smartTagInput', 'smartInput', 'autocompleteList');
const protocolTagInput = new TagInput('protocolTagInput', 'protocolInput');

// --- RULE EDITOR LOGIC ---

function renderRulesList() {
    rulesContainer.innerHTML = '';
    const rules = loadedConfig.routing.rules;
    
    rules.forEach((rule, index) => {
        const div = document.createElement('div');
        div.className = 'rule-item';
        if(index === currentRuleIndex) div.classList.add('active');

        // Description logic
        let title = rule.outboundTag || 'No Tag';
        let desc = '';
        if (rule.domain) desc += `Domains: ${rule.domain.length} `;
        if (rule.ip) desc += `IPs: ${rule.ip.length} `;
        if (rule.protocol) desc += `Proto: ${rule.protocol.join(', ')}`;
        if (!desc) desc = 'Custom/Complex Rule';

        div.innerHTML = `
            <div class="rule-info">
                <div class="rule-tag">${title}</div>
                <div class="rule-desc">${desc}</div>
            </div>
            <div class="rule-actions">
                <button class="icon-btn delete" title="Delete">&times;</button>
            </div>
        `;

        div.addEventListener('click', (e) => {
            if(!e.target.classList.contains('delete')) loadRule(index);
        });

        div.querySelector('.delete').addEventListener('click', (e) => {
            e.stopPropagation();
            if(confirm('Delete this rule?')) {
                rules.splice(index, 1);
                if(currentRuleIndex === index) showEmptyState();
                renderRulesList();
            }
        });

        rulesContainer.appendChild(div);
    });
}

function loadRule(index) {
    currentRuleIndex = index;
    const rule = loadedConfig.routing.rules[index];
    
    document.querySelectorAll('.rule-item').forEach(el => el.classList.remove('active'));
    rulesContainer.children[index]?.classList.add('active');

    emptyState.classList.add('hidden');
    editorForm.classList.remove('hidden');
    document.getElementById('ruleIndexDisplay').textContent = index + 1;

    document.getElementById('ruleOutbound').value = rule.outboundTag || '';
    
    const combinedTargets = [
        ...(rule.domain || []),
        ...(rule.ip || [])
    ];
    mainTagInput.setTags(combinedTargets);
    protocolTagInput.setTags(rule.protocol || []);
}

function saveCurrentRule() {
    if(currentRuleIndex === -1) return;

    const mixedTags = mainTagInput.tags;
    const domains = [];
    const ips = [];

    mixedTags.forEach(tag => {
        if(tag.startsWith('geoip:') || tag.startsWith('ext:geoip') || /^[\d\.:\/]+$/.test(tag)) {
            ips.push(tag);
        } else {
            domains.push(tag);
        }
    });

    const newRule = {
        type: "field",
        outboundTag: document.getElementById('ruleOutbound').value.trim()
    };

    if(domains.length) newRule.domain = domains;
    if(ips.length) newRule.ip = ips;
    if(protocolTagInput.tags.length) newRule.protocol = protocolTagInput.tags;

    // Merge custom keys from old rule (ports, etc)
    const oldRule = loadedConfig.routing.rules[currentRuleIndex];
    for(const key in oldRule) {
        if(!['type', 'outboundTag', 'domain', 'ip', 'protocol'].includes(key)) {
            newRule[key] = oldRule[key];
        }
    }

    loadedConfig.routing.rules[currentRuleIndex] = newRule;
    renderRulesList();
    
    const btn = document.getElementById('applyRuleBtn');
    const originalText = btn.textContent;
    btn.textContent = "Saved!";
    btn.style.backgroundColor = "#10b981";
    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.backgroundColor = "";
    }, 1000);
}

function setupEditorButtons() {
    document.getElementById('addRuleBtn').addEventListener('click', () => {
        if(!loadedConfig.routing) loadedConfig.routing = { rules: [] };
        loadedConfig.routing.rules.push({ type: "field", outboundTag: "blocked" });
        renderRulesList();
        loadRule(loadedConfig.routing.rules.length - 1);
    });

    document.getElementById('deleteRuleBtn').addEventListener('click', () => {
        if(currentRuleIndex > -1 && confirm('Delete?')) {
            loadedConfig.routing.rules.splice(currentRuleIndex, 1);
            showEmptyState();
            renderRulesList();
        }
    });

    document.getElementById('applyRuleBtn').addEventListener('click', saveCurrentRule);

    document.getElementById('saveConfigBtn').addEventListener('click', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(loadedConfig, null, 2));
        const anchor = document.createElement('a');
        anchor.setAttribute("href", dataStr);
        anchor.setAttribute("download", "config_edited.json");
        anchor.click();
    });
}

function renderOutboundTags() {
    const tags = new Set();
    (loadedConfig.outbounds || []).forEach(o => { if(o.tag) tags.add(o.tag); });
    (loadedConfig.routing.rules || []).forEach(r => { if(r.outboundTag) tags.add(r.outboundTag); });

    outboundSuggestions.innerHTML = '';
    tags.forEach(tag => {
        const chip = document.createElement('div');
        chip.className = 'out-chip';
        chip.textContent = tag;
        chip.addEventListener('click', () => {
            document.getElementById('ruleOutbound').value = tag;
        });
        outboundSuggestions.appendChild(chip);
    });
}

function showEmptyState() {
    currentRuleIndex = -1;
    emptyState.classList.remove('hidden');
    editorForm.classList.add('hidden');
    document.querySelectorAll('.rule-item').forEach(el => el.classList.remove('active'));
}