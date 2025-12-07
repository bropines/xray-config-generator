/* STATE */
let loadedConfig = { routing: { rules: [] }, outbounds: [] };
let geoSiteData = null;
let geoIpData = null;
let currentRuleIndex = -1;
let draggedItemIndex = null; // For Drag & Drop

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
setupMobileNav();

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
            // On mobile, stay on list. On desktop, show empty state.
            showEmptyState();
        } catch(err) { alert("Invalid JSON: " + err.message); }
    });

    document.getElementById('fileGeoSite').addEventListener('change', (e) => {
        if(e.target.files[0]) reader(e.target.files[0], (data) => parseProto(data, 'geosite', (res) => {
            geoSiteData = res;
            document.getElementById('statusGeoSite').classList.add('active');
        }));
    });

    document.getElementById('fileGeoIP').addEventListener('change', (e) => {
        if(e.target.files[0]) reader(e.target.files[0], (data) => parseProto(data, 'geoip', (res) => {
            geoIpData = res;
            document.getElementById('statusGeoIP').classList.add('active');
        }));
    });
}

// --- PROTOBUF WORKER ---
function parseProto(buffer, type, callback) {
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
                const list = msg.entry.map(e => ({
                    code: e.countryCode,
                    domains: type === 'geosite' ? (e.domain || []).map(d => d.value) : [],
                    count: type === 'geosite' ? (e.domain?.length||0) : (e.cidr?.length||0)
                }));
                self.postMessage({ success: true, data: list });
            } catch(err) { self.postMessage({ success: false, err: err.message }); }
        };
    `;
    const blob = new Blob([workerCode], {type: 'application/javascript'});
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (e) => {
        if(e.data.success) callback(e.data.data);
        worker.terminate();
    };
    worker.postMessage({ buffer, type, protoUrl: absoluteProtoUrl }, [buffer]);
}

// --- TAG INPUT CLASS ---
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
            if (e.key === 'Enter') { e.preventDefault(); this.addTag(this.input.value); }
            else if (e.key === 'Backspace' && !this.input.value && this.tags.length) this.removeTag(this.tags.length - 1);
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
        if (!clean || this.tags.includes(clean)) { this.input.value = ''; return; }
        this.createChip(clean);
        this.tags.push(clean);
        this.input.value = '';
        if(this.list) this.list.classList.add('hidden');
        if(this.onUpdate) this.onUpdate();
    }
    createChip(val) {
        const chip = document.createElement('div');
        chip.className = 'tag-chip ' + (val.startsWith('geoip:') || /^[\d\.:\/]+$/.test(val) ? 'ip-chip' : 'domain-chip');
        chip.innerHTML = `<span>${val}</span><span class="tag-remove">&times;</span>`;
        chip.querySelector('.tag-remove').addEventListener('click', (e) => { e.stopPropagation(); this.removeTag(this.tags.indexOf(val)); });
        this.container.insertBefore(chip, this.input);
    }
    removeTag(index) {
        this.tags.splice(index, 1);
        this.container.querySelectorAll('.tag-chip')[index].remove();
        if(this.onUpdate) this.onUpdate();
    }
    handleAutocomplete() {
        const q = this.input.value.toLowerCase();
        if (q.length < 2) { this.list.classList.add('hidden'); return; }
        const results = [];
        const search = (data, prefix, type) => {
            if(!data) return;
            for(const item of data) {
                if(item.code.toLowerCase().includes(q)) results.push({val: prefix+item.code, desc: item.count, type});
                else if(item.domains && q.length > 2 && item.domains.find(d=>d.toLowerCase().includes(q))) {
                    results.push({val: prefix+item.code, desc: `Includes "${q}"`, type});
                }
                if(results.length > 6) return;
            }
        };
        search(geoSiteData, 'geosite:', 'GeoSite');
        search(geoIpData, 'geoip:', 'GeoIP');
        if (!results.length) { this.list.classList.add('hidden'); return; }
        this.list.innerHTML = '';
        results.forEach(res => {
            const div = document.createElement('div'); div.className = 'suggestion-item';
            div.innerHTML = `<div><b>${res.val}</b> <small>${res.desc}</small></div><small>${res.type}</small>`;
            div.addEventListener('mousedown', () => this.addTag(res.val));
            this.list.appendChild(div);
        });
        this.list.classList.remove('hidden');
    }
}
const mainTagInput = new TagInput('smartTagInput', 'smartInput', 'autocompleteList');
const protocolTagInput = new TagInput('protocolTagInput', 'protocolInput');

// --- RULE LIST & DRAG-DROP ---
function renderRulesList() {
    rulesContainer.innerHTML = '';
    const rules = loadedConfig.routing.rules;
    
    rules.forEach((rule, index) => {
        const div = document.createElement('div');
        div.className = 'rule-item';
        div.draggable = true; // ENABLE DRAG
        div.dataset.index = index;
        if(index === currentRuleIndex) div.classList.add('active');

        let title = rule.outboundTag || 'No Tag';
        let desc = [
            rule.domain ? `Domain: ${rule.domain.length}` : '',
            rule.ip ? `IP: ${rule.ip.length}` : '',
            rule.protocol ? `Proto: ${rule.protocol.join(',')}` : ''
        ].filter(Boolean).join(' | ');

        div.innerHTML = `
            <div class="drag-handle" title="Drag to reorder">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>
            </div>
            <div class="rule-info">
                <div class="rule-tag">${title}</div>
                <div class="rule-desc">${desc || 'Empty Rule'}</div>
            </div>
        `;

        div.addEventListener('click', () => loadRule(index));

        // Drag Events
        div.addEventListener('dragstart', handleDragStart);
        div.addEventListener('dragover', handleDragOver);
        div.addEventListener('drop', handleDrop);
        div.addEventListener('dragenter', (e) => e.preventDefault());

        rulesContainer.appendChild(div);
    });
}

function handleDragStart(e) {
    draggedItemIndex = +this.dataset.index;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
    e.preventDefault(); // Necessary to allow dropping
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDrop(e) {
    e.stopPropagation();
    const droppedIndex = +this.dataset.index;
    if (draggedItemIndex !== droppedIndex) {
        // Reorder Array
        const rules = loadedConfig.routing.rules;
        const [movedRule] = rules.splice(draggedItemIndex, 1);
        rules.splice(droppedIndex, 0, movedRule);
        
        // Update selection if needed
        if (currentRuleIndex === draggedItemIndex) currentRuleIndex = droppedIndex;
        
        renderRulesList();
    }
    return false;
}

// --- EDITOR LOGIC ---
function loadRule(index) {
    currentRuleIndex = index;
    const rule = loadedConfig.routing.rules[index];
    
    document.querySelectorAll('.rule-item').forEach(el => el.classList.remove('active'));
    if(rulesContainer.children[index]) rulesContainer.children[index].classList.add('active');

    // Mobile Transition
    document.body.classList.add('is-editing');

    emptyState.classList.add('hidden');
    editorForm.classList.remove('hidden');
    document.getElementById('ruleIndexDisplay').textContent = index + 1;
    document.getElementById('ruleOutbound').value = rule.outboundTag || '';
    
    mainTagInput.setTags([...(rule.domain || []), ...(rule.ip || [])]);
    protocolTagInput.setTags(rule.protocol || []);
}

function saveCurrentRule() {
    if(currentRuleIndex === -1) return;
    const mixedTags = mainTagInput.tags;
    const domains = [], ips = [];
    
    mixedTags.forEach(tag => (tag.startsWith('geoip:') || /^[\d\.:\/]+$/.test(tag) ? ips : domains).push(tag));
    
    const newRule = { type: "field", outboundTag: document.getElementById('ruleOutbound').value.trim() };
    if(domains.length) newRule.domain = domains;
    if(ips.length) newRule.ip = ips;
    if(protocolTagInput.tags.length) newRule.protocol = protocolTagInput.tags;

    // Preserve extras
    const old = loadedConfig.routing.rules[currentRuleIndex];
    for(let k in old) if(!newRule.hasOwnProperty(k) && !['type','outboundTag','domain','ip','protocol'].includes(k)) newRule[k] = old[k];

    loadedConfig.routing.rules[currentRuleIndex] = newRule;
    renderRulesList();
    
    // Feedback
    const btn = document.getElementById('applyRuleBtn');
    const oldText = btn.textContent;
    btn.textContent = "Saved!";
    btn.style.background = "#10b981";
    setTimeout(() => { btn.textContent = oldText; btn.style.background = ""; }, 1000);
}

// --- MOBILE NAVIGATION & BUTTONS ---
function setupMobileNav() {
    document.getElementById('mobileBackBtn').addEventListener('click', () => {
        document.body.classList.remove('is-editing');
        currentRuleIndex = -1;
        document.querySelectorAll('.rule-item').forEach(el => el.classList.remove('active'));
    });
}

function setupEditorButtons() {
    document.getElementById('addRuleBtn').addEventListener('click', () => {
        if(!loadedConfig.routing) loadedConfig.routing = { rules: [] };
        loadedConfig.routing.rules.push({ type: "field", outboundTag: "blocked" });
        renderRulesList();
        loadRule(loadedConfig.routing.rules.length - 1);
    });

    document.getElementById('deleteRuleBtn').addEventListener('click', () => {
        if(confirm('Delete rule?')) {
            loadedConfig.routing.rules.splice(currentRuleIndex, 1);
            showEmptyState();
            renderRulesList();
            document.body.classList.remove('is-editing'); // Back to list on mobile
        }
    });

    document.getElementById('applyRuleBtn').addEventListener('click', saveCurrentRule);

    document.getElementById('saveConfigBtn').addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(loadedConfig, null, 2));
        a.download = "config_edited.json";
        a.click();
    });
}

function renderOutboundTags() {
    const tags = new Set();
    (loadedConfig.outbounds||[]).forEach(o=>o.tag && tags.add(o.tag));
    (loadedConfig.routing.rules||[]).forEach(r=>r.outboundTag && tags.add(r.outboundTag));
    outboundSuggestions.innerHTML = '';
    tags.forEach(t => {
        const el = document.createElement('div'); el.className='out-chip'; el.textContent=t;
        el.onclick=()=>document.getElementById('ruleOutbound').value=t;
        outboundSuggestions.appendChild(el);
    });
}

function showEmptyState() {
    currentRuleIndex = -1;
    emptyState.classList.remove('hidden');
    editorForm.classList.add('hidden');
}