// Professional HVAC System JavaScript
class HVACSystem {
  constructor() {
    this.currentUser = null;
    this.isAuthenticated = false;
    this.shoppingCart = JSON.parse(localStorage.getItem('hvacCart') || '[]');
    
    // Order Status Configuration
    this.orderStatuses = [
      { key: 'ORDER_PLACED', label: 'Order Placed', icon: 'shopping-cart' },
      { key: 'ORDER_CONFIRMED', label: 'Order Confirmed', icon: 'check-circle' },
      { key: 'PREPARING_ORDER', label: 'Preparing Order', icon: 'package' },
      { key: 'READY_FOR_DISPATCH', label: 'Ready for Dispatch', icon: 'truck' },
      { key: 'OUT_FOR_DELIVERY', label: 'Out for Delivery', icon: 'shipping' },
      { key: 'TECHNICIAN_EN_ROUTE', label: 'Technician En Route', icon: 'tools' },
      { key: 'DELIVERED', label: 'Delivered', icon: 'home' },
      { key: 'INSTALLATION_COMPLETED', label: 'Installation Completed', icon: 'check' },
      { key: 'ORDER_COMPLETED', label: 'Order Completed', icon: 'flag' }
    ];

    // Service Fees
    this.serviceFees = {
      'delivery-installation': 2500,
      'delivery-only': 800,
      'pickup': 0
    };
  }

  // Initialize System
  init() {
    this.setupEventListeners();
    this.updateCartCount();
    this.loadProducts();
    this.initializeAuth();
  }

  // Authentication Management
  initializeAuth() {
    if (!this.isAuthenticated) {
      // Show login prompt when trying to add to cart
      document.addEventListener('click', (e) => {
        if (e.target.matches('.add-to-cart') && !this.isAuthenticated) {
          e.preventDefault();
          this.showAuthPrompt();
        }
      });
    }
  }

  showAuthPrompt() {
    // Redirect to auth.ejs page instead of showing modal
    window.location.href = '/login';
  }

  // Product Loading with Inventory Validation
  async loadProducts() {
    try {
      // Use window.HVACProducts if available, otherwise fetch from API
      let products = window.HVACProducts;
      
      if (!products) {
        const response = await fetch('/api/products');
        products = await response.json();
      }
      
      this.renderProducts(products);
    } catch (error) {
      console.error('Error loading products:', error);
      this.showNotification('Error loading products', 'error');
    }
  }

  renderProducts(products) {
    const catalog = document.getElementById('productCatalog');
    if (!catalog) return;
    
    catalog.innerHTML = products.map(product => this.createProductCard(product)).join('');
  }

  createProductCard(product) {
    const stockStatus = this.getStockStatus(product.inventory);
    
    return `
      <div class="col-md-4">
        <div class="product-card-v2" data-type="${product.type}">
          <div class="product-img-container">
            <img src="${product.imageUrl}" alt="${product.name}" class="product-img">
            <span class="energy-rating">${product.energyRating || 'Standard'}</span>
            <span class="stock-badge ${stockStatus.class}">${stockStatus.label}</span>
          </div>
          
          <div class="p-3 d-flex flex-column" style="flex: 1;">
            <h6 class="fw-bold mb-1">${product.name}</h6>
            <div class="small text-muted mb-2">
              ${product.brand} · ${product.type}
            </div>
            <div class="small mb-2">
              <span class="text-primary fw-bold">₱${product.price.toLocaleString()}</span>
              <span class="text-muted">· ${product.warranty} months warranty</span>
            </div>
            <div class="small text-muted mb-3">${product.description}</div>
            
            <div class="mt-auto">
              <button class="btn btn-primary btn-sm w-100 view-product-details" 
                      data-product-id="${product.id}" 
                      data-name="${product.name}"
                      data-brand="${product.brand}"
                      data-description="${product.description}"
                      data-image="${product.imageUrl}"
                      data-warranty="${product.warranty}"
                      data-energy-rating="${product.energyRating}"
                      ${stockStatus.status === 'OUT_OF_STOCK' ? 'disabled' : ''}>
                <i class="bi bi-eye me-1"></i>
                ${stockStatus.status === 'OUT_OF_STOCK' ? 'Out of Stock' : 'View Details'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  getStockStatus(inventory) {
    if (!inventory || inventory.quantity_available === 0) {
      return { status: 'OUT_OF_STOCK', label: 'Out of Stock', class: 'stock-out' };
    } else if (inventory.quantity_available <= 3) {
      return { status: 'LOW_STOCK', label: 'Low Stock', class: 'stock-low' };
    } else {
      return { status: 'IN_STOCK', label: 'In Stock', class: 'stock-in' };
    }
  }

  // Product Details Modal
  showProductDetails(productData) {
    const product = this.findProductById(productData.productId);
    if (!product) return;

    // Populate modal with product data
    document.getElementById('modalProductImage').src = productData.image || product.imageUrl;
    document.getElementById('modalProductImage').alt = productData.name;
    document.getElementById('modalProductName').textContent = productData.name;
    document.getElementById('modalProductBrand').textContent = productData.brand;
    document.getElementById('modalProductDescription').textContent = productData.description;
    document.getElementById('modalProductWarranty').textContent = `${productData.warranty} months`;
    document.getElementById('modalEnergyRating').textContent = productData.energyRating || 'Standard';

    // Populate HP selection
    const hpSelect = document.getElementById('modalHPSelection');
    hpSelect.innerHTML = '';
    product.variants.forEach(variant => {
      const option = document.createElement('option');
      option.value = variant.id;
      option.dataset.price = variant.price;
      option.dataset.capacity = variant.capacity;
      option.textContent = `${variant.capacity} HP - ₱${variant.price.toLocaleString()}`;
      hpSelect.appendChild(option);
    });

    // Reset service selection
    document.querySelectorAll('.service-option').forEach(opt => opt.classList.remove('border-primary'));
    document.querySelector('.service-option[data-service="delivery-installation"]').classList.add('border-primary');

    // Update price display
    this.updateModalPrice();

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('productDetailsModal'));
    modal.show();
  }

  updateModalPrice() {
    const hpSelect = document.getElementById('modalHPSelection');
    const selectedOption = hpSelect.options[hpSelect.selectedIndex];
    const unitPrice = parseFloat(selectedOption.dataset.price);
    const selectedService = document.querySelector('.service-option.border-primary')?.dataset.service || 'delivery-installation';
    const serviceFee = this.serviceFees[selectedService];
    const totalPrice = unitPrice + serviceFee;

    document.getElementById('modalUnitPrice').textContent = `₱${unitPrice.toLocaleString()}`;
    document.getElementById('modalServiceFee').textContent = `₱${serviceFee.toLocaleString()}`;
    document.getElementById('modalTotalPrice').textContent = `₱${totalPrice.toLocaleString()}`;
  }

  findProductById(productId) {
    return window.HVACProducts?.find(p => p.id === productId);
  }

  // Add to cart from modal
  async addToCartFromModal() {
    // Check if user is authenticated
    if (!this.isAuthenticated) {
      // Store the current product selection for after login
      const hpSelect = document.getElementById('modalHPSelection');
      const selectedOption = hpSelect.options[hpSelect.selectedIndex];
      const selectedService = document.querySelector('.service-option.border-primary')?.dataset.service || 'delivery-installation';
      
      const productData = {
        productId: selectedOption.value,
        variantId: selectedOption.value,
        name: document.getElementById('modalProductName').textContent,
        brand: document.getElementById('modalProductBrand').textContent,
        capacity: selectedOption.dataset.capacity,
        price: parseFloat(selectedOption.dataset.price),
        deliveryOption: selectedService,
        deliveryFee: this.serviceFees[selectedService],
        quantity: 1,
        imageUrl: document.getElementById('modalProductImage').src,
        type: 'aircon', // Would come from product data
        warranty: document.getElementById('modalProductWarranty').textContent
      };
      
      // Store for after login
      sessionStorage.setItem('pendingCartItem', JSON.stringify(productData));
      sessionStorage.setItem('returnTo', '/cart');
      
      // Redirect to login
      window.location.href = '/login';
      return;
    }

    const hpSelect = document.getElementById('modalHPSelection');
    const selectedOption = hpSelect.options[hpSelect.selectedIndex];
    const selectedService = document.querySelector('.service-option.border-primary')?.dataset.service || 'delivery-installation';

    const productData = {
      productId: selectedOption.value,
      variantId: selectedOption.value,
      name: document.getElementById('modalProductName').textContent,
      brand: document.getElementById('modalProductBrand').textContent,
      capacity: selectedOption.dataset.capacity,
      price: parseFloat(selectedOption.dataset.price),
      deliveryOption: selectedService,
      deliveryFee: this.serviceFees[selectedService],
      quantity: 1,
      imageUrl: document.getElementById('modalProductImage').src,
      type: 'aircon', // Would come from product data
      warranty: document.getElementById('modalProductWarranty').textContent
    };

    await this.addToCart(productData);

    // Close modal after successful addition
    const modal = bootstrap.Modal.getInstance(document.getElementById('productDetailsModal'));
    if (modal) modal.hide();
  }
  async addToCart(productData) {
    if (!this.isAuthenticated) {
      this.showAuthPrompt();
      return;
    }

    // Validate inventory before adding
    const isValid = await this.validateInventory(productData.variantId, productData.quantity);
    if (!isValid) {
      this.showNotification('Product is out of stock', 'error');
      return;
    }

    const existingItem = this.shoppingCart.find(item => 
      item.productId === productData.productId && 
      item.variantId === productData.variantId && 
      item.deliveryOption === productData.deliveryOption
    );

    if (existingItem) {
      existingItem.quantity += productData.quantity;
    } else {
      this.shoppingCart.push(productData);
    }

    this.saveCart();
    this.updateCartCount();
    this.showNotification('Product added to cart!', 'success');
  }

  async validateInventory(variantId, quantity) {
    try {
      const response = await fetch(`/api/inventory/validate/${variantId}?quantity=${quantity}`);
      const result = await response.json();
      return result.available;
    } catch (error) {
      console.error('Inventory validation error:', error);
      return false;
    }
  }

  saveCart() {
    localStorage.setItem('hvacCart', JSON.stringify(this.shoppingCart));
  }

  updateCartCount() {
    const count = this.shoppingCart.reduce((total, item) => total + item.quantity, 0);
    const badge = document.getElementById('cartCount');
    if (badge) badge.textContent = count;
  }

  // Checkout Process
  async proceedToCheckout() {
    if (this.shoppingCart.length === 0) {
      this.showNotification('Your cart is empty', 'warning');
      return;
    }

    // Validate all items in cart
    for (const item of this.shoppingCart) {
      const isValid = await this.validateInventory(item.variantId, item.quantity);
      if (!isValid) {
        this.showNotification(`${item.name} is no longer available`, 'error');
        return;
      }
    }

    this.showCheckoutModal();
  }

  showCheckoutModal() {
    this.renderCheckoutSummary();
    this.setupCheckoutHandlers();
    
    const modal = new bootstrap.Modal(document.getElementById('checkoutModal'));
    modal.show();
  }

  renderCheckoutSummary() {
    const summary = document.getElementById('checkoutOrderSummary');
    if (!summary) return;
    
    const subtotal = this.shoppingCart.reduce((total, item) => total + (item.price * item.quantity), 0);
    
    summary.innerHTML = `
      <div class="mb-3">
        <h6 class="fw-bold">Order Items (${this.shoppingCart.length})</h6>
        ${this.shoppingCart.map(item => `
          <div class="d-flex justify-content-between align-items-center mb-2">
            <div>
              <div class="small fw-bold">${item.name}</div>
              <div class="small text-muted">${item.capacity} · ${item.deliveryOption.replace('-', ' + ')}</div>
            </div>
            <div class="text-end">
              <div class="small fw-bold">₱${item.price.toLocaleString()}</div>
              <div class="small text-muted">× ${item.quantity}</div>
            </div>
          </div>
        `).join('')}
      </div>
      
      <div class="border-top pt-3">
        <div class="d-flex justify-content-between mb-2">
          <span>Subtotal:</span>
          <span class="fw-bold">₱${subtotal.toLocaleString()}</span>
        </div>
        <div class="d-flex justify-content-between">
          <span>Delivery:</span>
          <span class="fw-bold" id="checkoutDeliveryFee">₱0</span>
        </div>
        <div class="d-flex justify-content-between mt-2 pt-2 border-top">
          <span class="h5 fw-bold">Total:</span>
          <span class="h5 fw-bold text-primary" id="checkoutTotal">₱${subtotal.toLocaleString()}</span>
        </div>
      </div>
    `;
  }

  setupCheckoutHandlers() {
    // Service selection
    document.querySelectorAll('.service-option').forEach(option => {
      option.addEventListener('click', () => {
        document.querySelectorAll('.service-option').forEach(opt => opt.classList.remove('border-primary'));
        option.classList.add('border-primary');
        
        const serviceType = option.dataset.service;
        this.updateServiceSelection(serviceType);
      });
    });
  }

  updateServiceSelection(serviceType) {
    const deliverySection = document.getElementById('deliveryAddressSection');
    const schedulingSection = document.getElementById('schedulingSection');
    const deliveryFee = this.serviceFees[serviceType];
    
    // Show/hide sections based on service type
    if (serviceType === 'pickup') {
      if (deliverySection) deliverySection.style.display = 'none';
      if (schedulingSection) schedulingSection.style.display = 'block';
    } else {
      if (deliverySection) deliverySection.style.display = 'block';
      if (schedulingSection) schedulingSection.style.display = 'block';
    }
    
    // Update delivery fee
    const subtotal = this.shoppingCart.reduce((total, item) => total + (item.price * item.quantity), 0);
    const total = subtotal + deliveryFee;
    
    const deliveryFeeElement = document.getElementById('checkoutDeliveryFee');
    const totalElement = document.getElementById('checkoutTotal');
    
    if (deliveryFeeElement) deliveryFeeElement.textContent = `₱${deliveryFee.toLocaleString()}`;
    if (totalElement) totalElement.textContent = `₱${total.toLocaleString()}`;
    
    // Load available time slots
    if (serviceType !== 'pickup') {
      this.loadAvailableTimeSlots(serviceType);
    } else {
      this.loadPickupDates();
    }
  }

  async loadAvailableTimeSlots(serviceType) {
    try {
      const response = await fetch(`/api/scheduling/available?service=${serviceType}`);
      const slots = await response.json();
      this.renderTimeSlots(slots);
    } catch (error) {
      console.error('Error loading time slots:', error);
    }
  }

  renderTimeSlots(slots) {
    const container = document.getElementById('availableSlots');
    if (!container) return;
    
    container.innerHTML = slots.map(slot => `
      <div class="time-slot ${slot.available ? '' : 'unavailable'}" data-date="${slot.date}" data-time="${slot.time}">
        <div class="d-flex justify-content-between align-items-center">
          <div>
            <div class="fw-bold">${this.formatDate(slot.date)}</div>
            <div class="small text-muted">${slot.time}</div>
            ${slot.technician ? `<div class="small text-primary">Tech: ${slot.technician.name}</div>` : ''}
          </div>
          <div>
            ${slot.available ? 
              '<i class="bi bi-check-circle text-success"></i>' : 
              '<i class="bi bi-x-circle text-muted"></i>'
            }
          </div>
        </div>
      </div>
    `).join('');
    
    // Add click handlers for available slots
    container.querySelectorAll('.time-slot:not(.unavailable)').forEach(slot => {
      slot.addEventListener('click', () => {
        document.querySelectorAll('.time-slot').forEach(s => s.classList.remove('selected'));
        slot.classList.add('selected');
        
        const deliveryDateElement = document.getElementById('deliveryDate');
        const timeSlotElement = document.getElementById('timeSlot');
        
        if (deliveryDateElement) deliveryDateElement.value = slot.dataset.date;
        if (timeSlotElement) timeSlotElement.value = slot.dataset.time;
      });
    });
  }

  // Order Placement
  async placeOrder() {
    const serviceOption = document.querySelector('.service-option.border-primary');
    const serviceType = serviceOption ? serviceOption.dataset.service : null;
    
    if (!serviceType) {
      this.showNotification('Please select a service option', 'warning');
      return;
    }

    const orderData = {
      customer_id: this.currentUser.id,
      items: this.shoppingCart,
      service_type: serviceType,
      delivery_address: this.getDeliveryAddress(),
      scheduled_date: document.getElementById('deliveryDate')?.value,
      scheduled_time: document.getElementById('timeSlot')?.value,
      payment_method: document.querySelector('input[name="paymentMethod"]:checked')?.value,
      total_amount: this.calculateTotal()
    };

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderData)
      });

      const result = await response.json();
      
      if (response.ok) {
        this.showNotification('Order placed successfully!', 'success');
        this.shoppingCart = [];
        this.saveCart();
        this.updateCartCount();
        
        // Close modals
        const checkoutModal = bootstrap.Modal.getInstance(document.getElementById('checkoutModal'));
        if (checkoutModal) checkoutModal.hide();
        
        // Show order confirmation
        this.showOrderConfirmation(result);
      } else {
        this.showNotification(result.error || 'Error placing order', 'error');
      }
    } catch (error) {
      console.error('Order placement error:', error);
      this.showNotification('Error placing order', 'error');
    }
  }

  // Order Tracking
  async trackOrder(orderId) {
    try {
      const response = await fetch(`/api/orders/${orderId}/tracking`);
      const trackingData = await response.json();
      this.renderTracking(trackingData);
    } catch (error) {
      console.error('Tracking error:', error);
      this.showNotification('Error loading tracking information', 'error');
    }
  }

  renderTracking(trackingData) {
    const timeline = document.getElementById('trackingTimeline');
    const details = document.getElementById('trackingOrderDetails');
    const deliveryInfo = document.getElementById('trackingDeliveryInfo');
    
    if (!timeline || !details || !deliveryInfo) return;
    
    // Render timeline
    timeline.innerHTML = this.orderStatuses.map(status => {
      const isCompleted = trackingData.completedStatuses && trackingData.completedStatuses.includes(status.key);
      const isActive = trackingData.currentStatus === status.key;
      
      return `
        <div class="tracking-item ${isCompleted ? 'completed' : ''} ${isActive ? 'active' : ''}">
          <div class="fw-bold">${status.label}</div>
          <div class="small text-muted">
            ${isActive ? 'In Progress' : isCompleted ? 'Completed' : 'Pending'}
          </div>
        </div>
      `;
    }).join('');
    
    // Render order details
    details.innerHTML = `
      <div class="small">
        <div class="mb-2">
          <span class="text-muted">Order Number:</span>
          <div class="fw-bold">#${trackingData.orderNumber}</div>
        </div>
        <div class="mb-2">
          <span class="text-muted">Service Type:</span>
          <div class="fw-bold">${trackingData.serviceType}</div>
        </div>
        <div class="mb-2">
          <span class="text-muted">Total Amount:</span>
          <div class="fw-bold">₱${trackingData.totalAmount.toLocaleString()}</div>
        </div>
      </div>
    `;
    
    // Render delivery info
    deliveryInfo.innerHTML = `
      <div class="small">
        ${trackingData.technician ? `
          <div class="mb-2">
            <span class="text-muted">Technician:</span>
            <div class="fw-bold">${trackingData.technician.name}</div>
            <div class="text-muted">${trackingData.technician.phone}</div>
          </div>
        ` : ''}
        <div class="mb-2">
          <span class="text-muted">Scheduled Date:</span>
          <div class="fw-bold">${this.formatDate(trackingData.scheduledDate)}</div>
        </div>
        <div class="mb-2">
          <span class="text-muted">Time Slot:</span>
          <div class="fw-bold">${trackingData.scheduledTime}</div>
        </div>
      </div>
    `;
  }

  // Utility Functions
  formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      weekday: 'short', 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  }

  calculateTotal() {
    const subtotal = this.shoppingCart.reduce((total, item) => total + (item.price * item.quantity), 0);
    const serviceOption = document.querySelector('.service-option.border-primary');
    const serviceType = serviceOption ? serviceOption.dataset.service : 'pickup';
    return subtotal + this.serviceFees[serviceType];
  }

  getDeliveryAddress() {
    const deliverySection = document.getElementById('deliveryAddressSection');
    if (deliverySection && deliverySection.style.display === 'none') {
      return null;
    }
    
    return {
      street: document.getElementById('addressStreet')?.value,
      city: document.getElementById('addressCity')?.value,
      province: document.getElementById('addressProvince')?.value,
      postal: document.getElementById('addressPostal')?.value
    };
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `alert alert-${type} notification-toast`;
    notification.innerHTML = `
      <div class="d-flex align-items-center">
        <i class="bi bi-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'} me-2"></i>
        <div>${message}</div>
      </div>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease forwards';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // Event Listeners
  setupEventListeners() {
    // Cart button
    const cartButton = document.getElementById('cartButton');
    if (cartButton) {
      cartButton.addEventListener('click', () => {
        this.renderCart();
        new bootstrap.Modal(document.getElementById('shoppingCartModal')).show();
      });
    }

    // Checkout button
    const checkoutButton = document.getElementById('proceedToCheckout');
    if (checkoutButton) {
      checkoutButton.addEventListener('click', () => {
        this.proceedToCheckout();
      });
    }

    // Place order button
    const placeOrderButton = document.getElementById('placeOrder');
    if (placeOrderButton) {
      placeOrderButton.addEventListener('click', () => {
        this.placeOrder();
      });
    }

    // Product filters
    document.querySelectorAll('[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const filter = btn.dataset.filter;
        document.querySelectorAll('.product-card-v2').forEach(card => {
          card.style.display = filter === 'all' || card.dataset.type === filter ? 'block' : 'none';
        });
      });
    });

    // Product details modal handlers
    document.addEventListener('click', (e) => {
      if (e.target.matches('.view-product-details')) {
        const btn = e.target;
        const productData = {
          productId: btn.dataset.productId,
          name: btn.dataset.name,
          brand: btn.dataset.brand,
          description: btn.dataset.description,
          image: btn.dataset.image,
          warranty: btn.dataset.warranty,
          energyRating: btn.dataset.energyRating
        };
        this.showProductDetails(productData);
      }
    });

    // HP selection change in modal
    const hpSelect = document.getElementById('modalHPSelection');
    if (hpSelect) {
      hpSelect.addEventListener('change', () => {
        this.updateModalPrice();
      });
    }

    // Service option selection in modal
    document.querySelectorAll('.service-option').forEach(option => {
      option.addEventListener('click', () => {
        document.querySelectorAll('.service-option').forEach(opt => opt.classList.remove('border-primary'));
        option.classList.add('border-primary');
        this.updateModalPrice();
      });
    });

    // Add to cart button in modal
    const modalAddToCart = document.getElementById('modalAddToCart');
    if (modalAddToCart) {
      modalAddToCart.addEventListener('click', () => {
        this.addToCartFromModal();
      });
    }
  }

  // Render cart
  renderCart() {
    const cartItems = document.getElementById('cartItems');
    if (!cartItems) return;
    
    if (this.shoppingCart.length === 0) {
      cartItems.innerHTML = '<p class="text-center text-muted">Your cart is empty</p>';
      return;
    }
    
    const subtotal = this.shoppingCart.reduce((total, item) => total + (item.price * item.quantity), 0);
    const deliveryTotal = this.shoppingCart.reduce((total, item) => total + (item.deliveryFee * item.quantity), 0);
    const total = subtotal + deliveryTotal;
    
    cartItems.innerHTML = `
      ${this.shoppingCart.map((item, index) => `
        <div class="d-flex align-items-center mb-3 p-3 border rounded">
          <img src="/images/products/aircon.jpg" alt="${item.name}" class="rounded me-3" style="width: 60px; height: 60px; object-fit: cover;">
          <div class="flex-grow-1">
            <div class="fw-bold">${item.name}</div>
            <div class="small text-muted">${item.capacity} · ${item.brand}</div>
            <div class="small text-muted">${item.deliveryOption.replace('-', ' + ')}</div>
          </div>
          <div class="text-end">
            <div class="fw-bold">₱${item.price.toLocaleString()}</div>
            <div class="small text-muted">× ${item.quantity}</div>
            <button class="btn btn-sm btn-outline-danger" onclick="hvacSystem.removeFromCart(${index})">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
      `).join('')}
    `;
    
    // Update totals
    const cartSubtotal = document.getElementById('cartSubtotal');
    const cartDeliveryTotal = document.getElementById('cartDeliveryTotal');
    const cartTotal = document.getElementById('cartTotal');
    
    if (cartSubtotal) cartSubtotal.textContent = `₱${subtotal.toLocaleString()}`;
    if (cartDeliveryTotal) cartDeliveryTotal.textContent = `₱${deliveryTotal.toLocaleString()}`;
    if (cartTotal) cartTotal.textContent = `₱${total.toLocaleString()}`;
  }

  removeFromCart(index) {
    this.shoppingCart.splice(index, 1);
    this.saveCart();
    this.updateCartCount();
    this.renderCart();
    this.showNotification('Item removed from cart', 'info');
  }

  // Set current user (called from EJS template)
  setCurrentUser(user, authenticated) {
    this.currentUser = user;
    this.isAuthenticated = authenticated;
  }
}

// Create global instance
let hvacSystem;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  hvacSystem = new HVACSystem();
  
  // Set user data from EJS template
  if (typeof window.currentUser !== 'undefined') {
    hvacSystem.setCurrentUser(window.currentUser, window.isAuthenticated);
  }
  
  hvacSystem.init();
  
  // Make it globally available
  window.hvacSystem = hvacSystem;
});
