document.addEventListener('DOMContentLoaded', () => {
    const SYMBOL_OPTIONS = [
        { value: 'BTCUSDT', label: 'BTC / USDT' },
        { value: 'ETHUSDT', label: 'ETH / USDT' },
        { value: 'OPUSDT', label: 'OP / USDT' },
        { value: 'SOLUSDT', label: 'SOL / USDT' },
        { value: 'BNBUSDT', label: 'BNB / USDT' },
    ];

    const state = {
        settings: null,
        currentSymbol: 'BTCUSDT',
        priceTimer: null,
        pollInterval: 15000,
        isFetchingPrice: false,
        lastPriceString: '--',
        alertHistory: [],
        lastErrorMessage: '',
    };

    const elements = {
        statusIndicator: document.getElementById('status-indicator'),
        openSettingsBtn: document.getElementById('open-settings-btn'),
        symbolDisplay: document.getElementById('symbol-display'),
        priceDigits: document.getElementById('price-digits'),
        timestampCard: document.getElementById('timestamp-card'),
        timestampFront: document.querySelector('#timestamp-card .front span'),
        timestampBack: document.querySelector('#timestamp-card .back span'),
        alertLog: document.getElementById('alert-log'),
        settingsModal: document.getElementById('settings-modal'),
        modalBackdrop: document.querySelector('#settings-modal .modal-backdrop'),
        closeSettingsBtn: document.getElementById('close-settings-btn'),
        symbolSelect: document.getElementById('symbol-select'),
        intervalInput: document.getElementById('interval-input'),
        rulesEmpty: document.getElementById('rules-empty'),
        rulesContainer: document.getElementById('rules-container'),
        addRuleBtn: document.getElementById('add-rule-btn'),
        emailSenderInput: document.getElementById('email-sender'),
        emailPasswordInput: document.getElementById('email-password'),
        emailReceiverInput: document.getElementById('email-receiver'),
        smtpServerInput: document.getElementById('smtp-server'),
        smtpPortInput: document.getElementById('smtp-port'),
        saveSettingsBtn: document.getElementById('save-settings-btn'),
        checkAlertsBtn: document.getElementById('check-alerts-btn'),
        settingsFeedback: document.getElementById('settings-feedback'),
        toast: document.getElementById('toast'),
    };

    let toastTimer = null;

    function init() {
        populateSymbolOptions();
        bindEvents();
        updateRulesEmptyState();
        updatePriceWithFlip('--');
        updateTimestamp(null);
        loadSettings();
    }

    function populateSymbolOptions(selectedSymbol) {
        const select = elements.symbolSelect;
        const fragment = document.createDocumentFragment();
        const existingValues = new Set();
        SYMBOL_OPTIONS.forEach(option => {
            existingValues.add(option.value);
            fragment.appendChild(createOptionElement(option.value, option.label));
        });
        if (selectedSymbol && !existingValues.has(selectedSymbol)) {
            fragment.appendChild(createOptionElement(selectedSymbol, selectedSymbol));
        }
        select.innerHTML = '';
        select.appendChild(fragment);
        select.value = (selectedSymbol && select.querySelector(`option[value="${selectedSymbol}"]`)) ? selectedSymbol : SYMBOL_OPTIONS[0].value;
    }

    function createOptionElement(value, label) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
    }

    function bindEvents() {
        elements.openSettingsBtn.addEventListener('click', openSettingsModal);
        elements.closeSettingsBtn.addEventListener('click', closeSettingsModal);
        elements.modalBackdrop.addEventListener('click', closeSettingsModal);
        elements.addRuleBtn.addEventListener('click', () => {
            addRuleRow();
            updateRulesEmptyState();
        });
        elements.saveSettingsBtn.addEventListener('click', handleSaveSettings);
        elements.checkAlertsBtn.addEventListener('click', handleManualCheck);
        elements.symbolSelect.addEventListener('change', () => {
            // Preview within settings only; actual apply after save
            elements.symbolSelect.value = elements.symbolSelect.value.toUpperCase();
        });
        window.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !elements.settingsModal.classList.contains('hidden')) {
                closeSettingsModal();
            }
        });
    }

    async function loadSettings() {
        setStatus('loading', '正在加载配置…');
        try {
            const response = await fetch('/api/settings');
            if (!response.ok) {
                throw new Error('无法获取设置');
            }
            const data = await response.json();
            state.settings = data;
            state.currentSymbol = data.symbol || state.currentSymbol;
            populateSymbolOptions(state.currentSymbol);
            populateSettingsForm(data);
            updateSymbolDisplay(state.currentSymbol);
            restartPolling();
            await fetchPrice();
        } catch (error) {
            setStatus('error', `加载设置失败：${error.message}`);
            showToast(`加载设置失败：${error.message}`, 'error');
        }
    }

    function populateSettingsForm(settings) {
        elements.symbolSelect.value = settings.symbol || SYMBOL_OPTIONS[0].value;
        elements.intervalInput.value = settings.check_interval || 15;

        const email = settings.email || {};
        elements.emailSenderInput.value = email.sender || '';
        elements.emailPasswordInput.value = email.password || '';
        elements.emailReceiverInput.value = email.receiver || '';
        elements.smtpServerInput.value = email.smtp_server || '';
        elements.smtpPortInput.value = email.smtp_port || '';

        elements.rulesContainer.innerHTML = '';
        const rules = settings.rules || [];
        if (rules.length === 0) {
            updateRulesEmptyState();
        } else {
            rules.forEach(rule => addRuleRow(rule));
            updateRuleIndices();
            updateRulesEmptyState();
        }
    }

    function openSettingsModal() {
        populateSettingsForm(state.settings || {});
        elements.settingsModal.classList.remove('hidden');
        document.body.classList.add('modal-open');
        clearSettingsFeedback();
    }

    function closeSettingsModal() {
        elements.settingsModal.classList.add('hidden');
        document.body.classList.remove('modal-open');
        clearSettingsFeedback();
    }

    function clearSettingsFeedback() {
        elements.settingsFeedback.textContent = '';
        elements.settingsFeedback.classList.remove('success', 'error');
    }

    function setSettingsFeedback(message, type = 'info') {
        elements.settingsFeedback.textContent = message;
        elements.settingsFeedback.classList.remove('success', 'error');
        if (type === 'success') {
            elements.settingsFeedback.classList.add('success');
        } else if (type === 'error') {
            elements.settingsFeedback.classList.add('error');
        }
    }

    function addRuleRow(rule = {}) {
        const row = document.createElement('div');
        row.className = 'rule-row';
        row.innerHTML = `
            <div class="rule-row-header">
                <span class="rule-index"></span>
                <button type="button" class="icon-button remove-rule" aria-label="删除规则">×</button>
            </div>
            <div class="rule-grid">
                <label class="field">
                    <span>规则类型</span>
                    <select class="rule-type">
                        <option value="buy">买入信号</option>
                        <option value="sell">卖出信号</option>
                        <option value="alert">区间提醒</option>
                    </select>
                </label>
                <label class="field rule-price-field">
                    <span class="rule-price-label">触发价格</span>
                    <input type="number" class="rule-price" step="0.0001" min="0" placeholder="请输入触发价格" />
                </label>
                <div class="field rule-range-field hidden">
                    <span>价格区间</span>
                    <div class="inline-inputs">
                        <label>
                            <span>下限</span>
                            <input type="number" class="rule-low" step="0.0001" min="0" placeholder="最低价格" />
                        </label>
                        <label>
                            <span>上限</span>
                            <input type="number" class="rule-high" step="0.0001" min="0" placeholder="最高价格" />
                        </label>
                    </div>
                </div>
                <label class="field rule-message-field">
                    <span>提醒消息</span>
                    <input type="text" class="rule-message" placeholder="触发时的提醒内容" />
                </label>
            </div>
        `;

        const typeSelect = row.querySelector('.rule-type');
        const priceField = row.querySelector('.rule-price-field');
        const priceLabel = row.querySelector('.rule-price-label');
        const priceInput = row.querySelector('.rule-price');
        const rangeField = row.querySelector('.rule-range-field');
        const lowInput = row.querySelector('.rule-low');
        const highInput = row.querySelector('.rule-high');
        const messageInput = row.querySelector('.rule-message');
        const removeBtn = row.querySelector('.remove-rule');

        const initialType = (rule.type || 'buy').toLowerCase();
        typeSelect.value = initialType;
        messageInput.value = rule.message || '';

        if (initialType === 'alert') {
            priceField.classList.add('hidden');
            rangeField.classList.remove('hidden');
            lowInput.value = rule.low ?? '';
            highInput.value = rule.high ?? '';
        } else {
            priceField.classList.remove('hidden');
            rangeField.classList.add('hidden');
            priceInput.value = rule.price ?? '';
        }
        syncPriceLabel(priceLabel, initialType);

        typeSelect.addEventListener('change', () => {
            const selected = typeSelect.value;
            if (selected === 'alert') {
                priceField.classList.add('hidden');
                rangeField.classList.remove('hidden');
                priceInput.value = '';
            } else {
                priceField.classList.remove('hidden');
                rangeField.classList.add('hidden');
                lowInput.value = '';
                highInput.value = '';
            }
            syncPriceLabel(priceLabel, selected);
        });

        removeBtn.addEventListener('click', () => {
            row.remove();
            updateRuleIndices();
            updateRulesEmptyState();
        });

        elements.rulesContainer.appendChild(row);
        updateRuleIndices();
    }

    function syncPriceLabel(labelElement, type) {
        if (type === 'buy') {
            labelElement.textContent = '买入触发价格';
        } else if (type === 'sell') {
            labelElement.textContent = '卖出触发价格';
        } else {
            labelElement.textContent = '触发价格';
        }
    }

    function updateRuleIndices() {
        const indices = elements.rulesContainer.querySelectorAll('.rule-index');
        indices.forEach((span, idx) => {
            span.textContent = `规则 ${idx + 1}`;
        });
    }

    function updateRulesEmptyState() {
        const hasRules = elements.rulesContainer.children.length > 0;
        elements.rulesEmpty.classList.toggle('hidden', hasRules);
    }

    function collectSettingsFromForm() {
        const symbol = (elements.symbolSelect.value || '').toUpperCase();
        const intervalValue = Number(elements.intervalInput.value);
        if (!symbol) {
            throw new Error('请选择监控的交易对');
        }
        if (!Number.isFinite(intervalValue) || intervalValue < 5) {
            throw new Error('检查间隔至少需为 5 秒');
        }
        const email = {
            sender: elements.emailSenderInput.value.trim(),
            password: elements.emailPasswordInput.value.trim(),
            receiver: elements.emailReceiverInput.value.trim(),
        };
        const smtpServer = elements.smtpServerInput.value.trim();
        const smtpPortRaw = elements.smtpPortInput.value.trim();
        if (smtpServer) {
            email.smtp_server = smtpServer;
        }
        if (smtpPortRaw) {
            const smtpPortNumber = Number(smtpPortRaw);
            if (!Number.isFinite(smtpPortNumber) || smtpPortNumber <= 0) {
                throw new Error('SMTP 端口需为正整数');
            }
            email.smtp_port = Math.round(smtpPortNumber);
        }

        const rules = collectRulesFromForm();
        return {
            symbol,
            check_interval: Math.round(intervalValue),
            email,
            rules,
        };
    }

    function collectRulesFromForm() {
        const rows = Array.from(elements.rulesContainer.querySelectorAll('.rule-row'));
        const rules = [];
        rows.forEach((row, index) => {
            const type = row.querySelector('.rule-type').value;
            const message = row.querySelector('.rule-message').value.trim();
            if (type === 'alert') {
                const low = parseFloat(row.querySelector('.rule-low').value);
                const high = parseFloat(row.querySelector('.rule-high').value);
                if (!Number.isFinite(low) || !Number.isFinite(high)) {
                    throw new Error(`规则 ${index + 1} 的上下限需填写有效数字`);
                }
                if (low <= 0 || high <= 0 || low >= high) {
                    throw new Error(`规则 ${index + 1} 的区间设置不合理`);
                }
                rules.push({
                    type: 'alert',
                    condition: 'between',
                    low,
                    high,
                    message,
                });
            } else {
                const price = parseFloat(row.querySelector('.rule-price').value);
                if (!Number.isFinite(price) || price <= 0) {
                    throw new Error(`规则 ${index + 1} 的触发价格需大于 0`);
                }
                rules.push({
                    type,
                    condition: type === 'buy' ? 'below' : 'above',
                    price,
                    message,
                });
            }
        });
        return rules;
    }

    async function handleSaveSettings() {
        try {
            const payload = collectSettingsFromForm();
            setSettingsFeedback('正在保存设置…');
            setButtonLoading(elements.saveSettingsBtn, true, '保存中…');
            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || '保存失败');
            }
            state.settings = data.settings;
            state.currentSymbol = state.settings.symbol;
            populateSettingsForm(state.settings);
            updateSymbolDisplay(state.currentSymbol);
            setSettingsFeedback('设置已保存并生效', 'success');
            showToast('设置已保存', 'success');
            restartPolling();
            closeSettingsModal();
        } catch (error) {
            setSettingsFeedback(error.message, 'error');
            showToast(`保存失败：${error.message}`, 'error');
        } finally {
            setButtonLoading(elements.saveSettingsBtn, false);
        }
    }

    async function handleManualCheck() {
        setButtonLoading(elements.checkAlertsBtn, true, '检查中…');
        setSettingsFeedback('正在检查提醒…');
        try {
            const response = await fetch('/api/check-alerts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: state.currentSymbol }),
            });
            const data = await response.json();
            if (!response.ok) {
                const message = data.error || '检查提醒失败';
                throw new Error(message);
            }
            if (data.price) {
                updatePriceUI(data.price);
            }
            const triggered = data.triggered || [];
            if (triggered.length > 0) {
                appendAlertLog(triggered);
                setSettingsFeedback(`本次触发 ${triggered.length} 条提醒`, 'success');
                showToast(`已触发 ${triggered.length} 条提醒`, 'success');
            } else {
                setSettingsFeedback('未触发任何提醒规则', 'info');
                showToast('未触发提醒规则', 'warning');
            }
        } catch (error) {
            setSettingsFeedback(error.message, 'error');
            showToast(`提醒检查失败：${error.message}`, 'error');
        } finally {
            setButtonLoading(elements.checkAlertsBtn, false);
        }
    }

    function restartPolling() {
        if (state.priceTimer) {
            clearInterval(state.priceTimer);
            state.priceTimer = null;
        }
        const intervalSec = Math.max(Number(state.settings?.check_interval) || 15, 5);
        state.pollInterval = intervalSec * 1000;
        state.priceTimer = setInterval(fetchPrice, state.pollInterval);
        fetchPrice();
    }

    async function fetchPrice() {
        if (state.isFetchingPrice) {
            return;
        }
        state.isFetchingPrice = true;
        if (!state.lastPriceString || state.lastPriceString === '--') {
            setStatus('loading', '正在获取价格…');
        }
        try {
            const response = await fetch(`/api/price/${state.currentSymbol}`);
            const data = await response.json();
            if (!response.ok) {
                const message = data.error || '价格获取失败';
                throw new Error(message);
            }
            updatePriceUI(data);
        } catch (error) {
            setStatus('error', `获取价格失败：${error.message}`);
            if (state.lastErrorMessage !== error.message) {
                showToast(`价格获取失败：${error.message}`, 'error');
                state.lastErrorMessage = error.message;
            }
        } finally {
            state.isFetchingPrice = false;
        }
    }

    function updatePriceUI(priceInfo) {
        if (!priceInfo) {
            return;
        }
        updatePriceWithFlip(priceInfo.price);
        updateTimestamp(priceInfo.timestamp);
        updateSymbolDisplay(priceInfo.symbol || state.currentSymbol);

        const sourceLabel = priceInfo.source ? priceInfo.source.toUpperCase() : '未知来源';
        if (priceInfo.stale) {
            setStatus('warning', `使用缓存数据 · 上次来源 ${sourceLabel}`);
        } else {
            setStatus('connected', `已连接 · ${sourceLabel}`);
        }
        state.lastPriceString = formatPrice(priceInfo.price);
        state.lastErrorMessage = '';
    }

    function updateSymbolDisplay(symbol) {
        state.currentSymbol = symbol;
        elements.symbolDisplay.textContent = symbol;
    }

    function updatePriceWithFlip(value) {
        const formatted = typeof value === 'string' ? value : formatPrice(value);
        const chars = formatted.split('');
        const container = elements.priceDigits;

        for (let index = 0; index < chars.length; index += 1) {
            const char = chars[index];
            let digitElement = container.children[index];
            if (!digitElement) {
                digitElement = createDigitElement(char);
                container.appendChild(digitElement);
            }
            updateDigitElement(digitElement, char);
        }

        while (container.children.length > chars.length) {
            container.removeChild(container.lastElementChild);
        }
    }

    function createDigitElement(char) {
        const wrapper = document.createElement('div');
        wrapper.className = 'digit flip-container';
        applyDigitClasses(wrapper, char);
        wrapper.dataset.value = char;

        const card = document.createElement('div');
        card.className = 'flip-card';

        const front = document.createElement('div');
        front.className = 'flip-face front';
        const frontSpan = document.createElement('span');
        frontSpan.textContent = char;
        front.appendChild(frontSpan);

        const back = document.createElement('div');
        back.className = 'flip-face back';
        const backSpan = document.createElement('span');
        backSpan.textContent = char;
        back.appendChild(backSpan);

        card.appendChild(front);
        card.appendChild(back);
        wrapper.appendChild(card);
        return wrapper;
    }

    function updateDigitElement(digitElement, nextChar) {
        applyDigitClasses(digitElement, nextChar);
        const currentValue = digitElement.dataset.value;
        if (currentValue === nextChar) {
            return;
        }
        digitElement.dataset.value = nextChar;
        const card = digitElement.querySelector('.flip-card');
        const frontSpan = card.querySelector('.front span');
        const backSpan = card.querySelector('.back span');
        backSpan.textContent = nextChar;
        card.classList.add('flipped');
        card.addEventListener('transitionend', event => {
            if (event.propertyName !== 'transform') {
                return;
            }
            card.classList.remove('flipped');
            frontSpan.textContent = nextChar;
        }, { once: true });
    }

    function applyDigitClasses(element, char) {
        const isNumber = /[0-9]/.test(char);
        element.classList.toggle('digit-symbol', !isNumber);
        element.classList.toggle('digit-small', char === '.' || char === '-');
    }

    function updateTimestamp(isoString) {
        const card = elements.timestampCard;
        const frontSpan = elements.timestampFront;
        const backSpan = elements.timestampBack;
        const formatted = isoString ? formatTimestamp(isoString) : '--';
        if (frontSpan.textContent === formatted) {
            return;
        }
        backSpan.textContent = formatted;
        card.classList.add('flipped');
        card.addEventListener('transitionend', event => {
            if (event.propertyName !== 'transform') {
                return;
            }
            card.classList.remove('flipped');
            frontSpan.textContent = formatted;
        }, { once: true });
    }

    function formatPrice(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return '--';
        }
        let decimals = 4;
        if (number >= 1000) {
            decimals = 2;
        } else if (number >= 100) {
            decimals = 2;
        } else if (number >= 10) {
            decimals = 3;
        } else if (number >= 1) {
            decimals = 4;
        } else {
            decimals = 6;
        }
        return number.toFixed(decimals);
    }

    function formatTimestamp(isoString) {
        const date = isoString ? new Date(isoString) : null;
        if (!date || Number.isNaN(date.getTime())) {
            return '--';
        }
        const datePart = date.toLocaleDateString('zh-CN');
        const timePart = date.toLocaleTimeString('zh-CN', { hour12: false });
        return `${datePart} ${timePart}`;
    }

    function setStatus(mode, text) {
        const indicator = elements.statusIndicator;
        indicator.textContent = text;
        indicator.className = `status status-${mode}`;
    }

    function setButtonLoading(button, loading, loadingText) {
        if (!button) {
            return;
        }
        if (loading) {
            if (!button.dataset.originalText) {
                button.dataset.originalText = button.textContent;
            }
            if (loadingText) {
                button.textContent = loadingText;
            }
            button.disabled = true;
        } else {
            if (button.dataset.originalText) {
                button.textContent = button.dataset.originalText;
                delete button.dataset.originalText;
            }
            button.disabled = false;
        }
    }

    function showToast(message, type = 'info') {
        const toast = elements.toast;
        toast.textContent = message;
        toast.classList.remove('hidden', 'success', 'error', 'warning', 'show');
        if (type !== 'info') {
            toast.classList.add(type);
        }
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
        if (toastTimer) {
            clearTimeout(toastTimer);
        }
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 3400);
    }

    function appendAlertLog(triggered) {
        const now = new Date();
        triggered.forEach(item => {
            state.alertHistory.unshift({
                timestamp: now,
                ruleMessage: item.rule?.message || '提醒触发',
                currentPrice: item.current_price,
                emailSent: Boolean(item.email_sent),
                skippedReason: item.skipped_reason || '',
            });
        });
        state.alertHistory = state.alertHistory.slice(0, 30);
        renderAlertLog();
    }

    function renderAlertLog() {
        const container = elements.alertLog;
        container.innerHTML = '';
        if (state.alertHistory.length === 0) {
            container.textContent = '暂无提醒记录';
            return;
        }
        state.alertHistory.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'alert-item';
            if (entry.emailSent) {
                item.classList.add('success');
            } else if (entry.skippedReason) {
                item.classList.add('warning');
            }
            const message = document.createElement('div');
            message.className = 'alert-message';
            message.textContent = entry.ruleMessage;

            const meta = document.createElement('div');
            meta.className = 'alert-meta';
            const details = [formatLogTimestamp(entry.timestamp)];
            if (entry.currentPrice !== undefined && entry.currentPrice !== null) {
                details.push(`当前价格 ${formatPrice(entry.currentPrice)}`);
            }
            const statusText = entry.emailSent
                ? '已发送邮件提醒'
                : entry.skippedReason || '提醒已触发';
            details.push(statusText);
            meta.textContent = details.join(' · ');

            item.appendChild(message);
            item.appendChild(meta);
            container.appendChild(item);
        });
    }

    function formatLogTimestamp(date) {
        const target = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(target.getTime())) {
            return '--';
        }
        const year = target.getFullYear();
        const month = String(target.getMonth() + 1).padStart(2, '0');
        const day = String(target.getDate()).padStart(2, '0');
        const hours = String(target.getHours()).padStart(2, '0');
        const minutes = String(target.getMinutes()).padStart(2, '0');
        const seconds = String(target.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    init();
});
