// Sidebar toggle functionality
document.addEventListener('DOMContentLoaded', function() {
    const sidebarHandle = document.getElementById('sidebarHandle');
    const adminSidebar = document.getElementById('adminSidebar');
    const adminContent = document.querySelector('.admin-content');
    
    if (!sidebarHandle || !adminSidebar || !adminContent) return;
    
    // Load sidebar state from localStorage
    const sidebarState = localStorage.getItem('sidebarCollapsed') === 'true';
    
    // Apply initial state
    function setSidebarState(collapsed) {
        if (collapsed) {
            adminSidebar.classList.add('collapsed');
            adminContent.classList.add('sidebar-collapsed');
            sidebarHandle.innerHTML = '<i class="bi bi-chevron-right" aria-hidden="true"></i>';
            sidebarHandle.setAttribute('aria-expanded', 'false');
        } else {
            adminSidebar.classList.remove('collapsed');
            adminContent.classList.remove('sidebar-collapsed');
            sidebarHandle.innerHTML = '<i class="bi bi-chevron-left" aria-hidden="true"></i>';
            sidebarHandle.setAttribute('aria-expanded', 'true');
        }
        localStorage.setItem('sidebarCollapsed', collapsed);
    }
    
    // Apply saved state
    setSidebarState(sidebarState);
    
    // Toggle sidebar on handle click
    sidebarHandle.addEventListener('click', function(e) {
        e.preventDefault();
        const isCollapsed = adminSidebar.classList.contains('collapsed');
        setSidebarState(!isCollapsed);
    });
    
    // Handle keyboard navigation
    sidebarHandle.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            sidebarHandle.click();
        }
    });
    
    // Auto-collapse on mobile
    function checkMobile() {
        if (window.innerWidth < 768) {
            setSidebarState(true);
        }
    }
    
    window.addEventListener('resize', debounce(checkMobile, 250));
    checkMobile();
    
    // Active navigation highlighting
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('.sidebar .nav-link');
    
    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPath || (href && currentPath.startsWith(href) && href !== '/')) {
            link.classList.add('active');
            
            // Expand parent collapse if applicable
            const collapse = link.closest('.collapse');
            if (collapse) {
                const toggle = document.querySelector(`[data-bs-target="#${collapse.id}"]`);
                if (toggle) {
                    toggle.classList.add('active');
                    toggle.setAttribute('aria-expanded', 'true');
                    collapse.classList.add('show');
                }
            }
        }
    });
    
    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // Add hover effects for sidebar items
    const navItems = document.querySelectorAll('.sidebar .nav-item');
    navItems.forEach(item => {
        item.addEventListener('mouseenter', function() {
            this.classList.add('hover');
        });
        
        item.addEventListener('mouseleave', function() {
            this.classList.remove('hover');
        });
    });
    
    // Handle collapse animations
    const collapses = document.querySelectorAll('.sidebar .collapse');
    collapses.forEach(collapse => {
        collapse.addEventListener('show.bs.collapse', function() {
            const toggle = document.querySelector(`[data-bs-target="#${this.id}"]`);
            if (toggle) {
                toggle.classList.add('active');
                toggle.setAttribute('aria-expanded', 'true');
            }
        });
        
        collapse.addEventListener('hide.bs.collapse', function() {
            const toggle = document.querySelector(`[data-bs-target="#${this.id}"]`);
            if (toggle) {
                toggle.classList.remove('active');
                toggle.setAttribute('aria-expanded', 'false');
            }
        });
    });
    
    // Add keyboard navigation for sidebar
    document.addEventListener('keydown', function(e) {
        // Ctrl/Cmd + B to toggle sidebar
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
            e.preventDefault();
            sidebarHandle.click();
        }
        
        // Escape to focus main content
        if (e.key === 'Escape' && document.activeElement.closest('.sidebar')) {
            const mainContent = document.querySelector('.admin-content main');
            if (mainContent) {
                mainContent.focus();
            }
        }
    });
    
    // Make sidebar focusable for accessibility
    adminSidebar.setAttribute('tabindex', '-1');
    
    // Add focus trap for sidebar when open
    function trapFocus(element) {
        const focusableElements = element.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];
        
        element.addEventListener('keydown', function(e) {
            if (e.key === 'Tab') {
                if (e.shiftKey) {
                    if (document.activeElement === firstFocusable) {
                        lastFocusable.focus();
                        e.preventDefault();
                    }
                } else {
                    if (document.activeElement === lastFocusable) {
                        firstFocusable.focus();
                        e.preventDefault();
                    }
                }
            }
        });
    }
    
    trapFocus(adminSidebar);
});
