// Global JavaScript utilities and functions

// Toast notification system
window.notify = function(message, type = 'info', duration = 5000) {
    const toastContainer = document.getElementById('globalToastContainer');
    if (!toastContainer) return;
    
    const toastId = 'toast-' + Date.now();
    const toastHtml = `
        <div id="${toastId}" class="toast align-items-center text-white bg-${type === 'error' ? 'danger' : type} border-0" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="d-flex">
                <div class="toast-body">
                    ${message}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        </div>
    `;
    
    toastContainer.insertAdjacentHTML('beforeend', toastHtml);
    const toastElement = document.getElementById(toastId);
    const toast = new bootstrap.Toast(toastElement, { delay: duration });
    toast.show();
    
    toastElement.addEventListener('hidden.bs.toast', () => {
        toastElement.remove();
    });
};

// Global confirm dialog
window.confirmAction = function(message, callback) {
    const modal = document.getElementById('globalConfirmModal');
    const modalBody = modal.querySelector('.modal-body');
    const yesBtn = modal.querySelector('.js-confirm-yes');
    const noBtn = modal.querySelector('.js-confirm-no');
    
    modalBody.textContent = message;
    
    const cleanup = () => {
        yesBtn.removeEventListener('click', handleYes);
        noBtn.removeEventListener('click', handleNo);
    };
    
    const handleYes = () => {
        cleanup();
        bootstrap.Modal.getInstance(modal).hide();
        callback(true);
    };
    
    const handleNo = () => {
        cleanup();
        bootstrap.Modal.getInstance(modal).hide();
        callback(false);
    };
    
    yesBtn.addEventListener('click', handleYes);
    noBtn.addEventListener('click', handleNo);
    
    new bootstrap.Modal(modal).show();
};

// Global prompt dialog
window.promptInput = function(message, defaultValue = '', callback) {
    const modal = document.getElementById('globalPromptModal');
    const modalBody = modal.querySelector('.modal-body input');
    const yesBtn = modal.querySelector('.js-prompt-yes');
    const noBtn = modal.querySelector('.js-prompt-no');
    
    modalBody.value = defaultValue;
    
    const cleanup = () => {
        yesBtn.removeEventListener('click', handleYes);
        noBtn.removeEventListener('click', handleNo);
    };
    
    const handleYes = () => {
        cleanup();
        bootstrap.Modal.getInstance(modal).hide();
        callback(modalBody.value);
    };
    
    const handleNo = () => {
        cleanup();
        bootstrap.Modal.getInstance(modal).hide();
        callback(null);
    };
    
    yesBtn.addEventListener('click', handleYes);
    noBtn.addEventListener('click', handleNo);
    
    new bootstrap.Modal(modal).show();
    modalBody.focus();
    modalBody.select();
};

// Format currency
window.formatCurrency = function(amount) {
    return '₱' + parseFloat(amount).toLocaleString('en-PH', { minimumFractionDigits: 2 });
};

// Format date
window.formatDate = function(dateString, options = {}) {
    const date = new Date(dateString);
    const defaults = {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    };
    return date.toLocaleDateString('en-PH', { ...defaults, ...options });
};

// Format time
window.formatTime = function(timeString) {
    const [hours, minutes] = timeString.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minutes} ${ampm}`;
};

// Debounce function
window.debounce = function(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

// Loading state helper
window.setLoading = function(element, loading = true) {
    if (loading) {
        element.disabled = true;
        element.dataset.originalText = element.textContent;
        element.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Loading...';
    } else {
        element.disabled = false;
        element.textContent = element.dataset.originalText;
        delete element.dataset.originalText;
    }
};

// API helper with error handling
window.apiCall = async function(url, options = {}) {
    try {
        const response = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            credentials: 'same-origin',
            ...options
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('API call failed:', error);
        notify(error.message, 'error');
        throw error;
    }
};

// Initialize tooltips
document.addEventListener('DOMContentLoaded', function() {
    // Initialize Bootstrap tooltips
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });
    
    // Initialize Bootstrap popovers
    const popoverTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="popover"]'));
    popoverTriggerList.map(function (popoverTriggerEl) {
        return new bootstrap.Popover(popoverTriggerEl);
    });
});
