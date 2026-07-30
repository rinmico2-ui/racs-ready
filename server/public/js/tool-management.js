// Professional Tool Management JavaScript
class ToolManagement {
  constructor() {
    this.apiBase = window.TOOL_USAGE_CONTEXT?.apiBase || '/api/admin';
    this.currentEditId = null;
    this.modal = null;
    this.form = null;
    this.init();
  }

  init() {
    this.bindEvents();
    this.initializeModal();
    this.loadTools();
  }

  bindEvents() {
    // Add tool button
    document.getElementById('addToolBtn')?.addEventListener('click', () => {
      this.openAddModal();
    });

    // Form submission
    const form = document.getElementById('toolManagementForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveTool();
      });
    }
  }

  initializeModal() {
    this.modal = document.getElementById('toolManagementModal');
    this.form = document.getElementById('toolManagementForm');
    
    // Form validation
    if (this.form) {
      this.form.addEventListener('submit', (e) => {
        if (!this.form.checkValidity()) {
          e.preventDefault();
          e.stopPropagation();
        }
        this.form.classList.add('was-validated');
      });
    }

    // Custom modal event listeners
    this.modal?.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.hideModal();
      }
    });

    // Prevent body scroll when modal is open
    this.setupBodyScrollLock();
  }

  setupBodyScrollLock() {
    // Store original body overflow
    this.originalBodyOverflow = document.body.style.overflow;
  }

  openAddModal() {
    this.currentEditId = null;
    this.resetForm();
    document.getElementById('modalTitle').textContent = 'Add New Tool';
    document.getElementById('saveToolBtn').innerHTML = '<i class="bi bi-check-circle me-1"></i>Save Tool';
    
    this.showModal();
  }

  openEditModal(toolId) {
    this.currentEditId = toolId;
    this.loadToolForEdit(toolId);
    document.getElementById('modalTitle').textContent = 'Edit Tool';
    document.getElementById('saveToolBtn').innerHTML = '<i class="bi bi-save me-1"></i>Update Tool';
    
    this.showModal();
  }

  showModal() {
    if (this.modal) {
      // Lock body scroll
      document.body.style.overflow = 'hidden';
      
      // Show modal with flex for proper centering
      this.modal.style.display = 'flex';
      this.modal.classList.remove('closing');
      
      // Ensure proper alignment
      this.modal.style.alignItems = 'center';
      this.modal.style.justifyContent = 'center';
      
      // Focus on first input after a short delay
      setTimeout(() => {
        const firstInput = this.modal.querySelector('input:not([type="hidden"])');
        if (firstInput) {
          firstInput.focus();
        }
      }, 200);
    }
  }

  hideModal() {
    if (this.modal) {
      // Add closing animation
      this.modal.classList.add('closing');
      
      // Hide after animation
      setTimeout(() => {
        this.modal.style.display = 'none';
        this.modal.classList.remove('closing');
        
        // Restore body scroll
        document.body.style.overflow = this.originalBodyOverflow || '';
      }, 300);
    }
  }

  resetForm() {
    if (this.form) {
      this.form.reset();
      this.form.classList.remove('was-validated');
      
      // Set default values
      document.getElementById('toolMinStock').value = '3';
      document.getElementById('toolIsStockItem').checked = true;
      document.getElementById('toolActive').checked = true;
    }
  }

  async loadTools() {
    try {
      const response = await fetch('/api/admin/tools');
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load tools');
      }
      
      this.renderToolsTable(data.tools || []);
      this.updateToolCount(data.tools?.length || 0);
    } catch (error) {
      console.error('Error loading tools:', error);
      this.showNotification('Failed to load tools', 'danger');
    }
  }

  async loadToolForEdit(toolId) {
    try {
      const response = await fetch(`/api/admin/tools/${toolId}`);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load tool');
      }
      
      this.populateForm(data.tool);
      this.showModal();
    } catch (error) {
      console.error('Error loading tool for edit:', error);
      this.showNotification('Failed to load tool details', 'danger');
    }
  }

  populateForm(tool) {
    const fields = {
      'toolName': tool.itemName || '',
      'toolUnit': tool.unit || 'pcs',
      'toolQuantity': tool.quantity || 0,
      'toolMinStock': tool.minStockLevel || 3,
      'toolStatus': tool.status || 'in_stock',
      'toolIsStockItem': tool.isStockItem !== false,
      'toolCostPrice': tool.costPrice || 0,
      'toolSellingPrice': tool.sellingPrice || 0,
      'toolSupplier': tool.supplier || '',
      'toolSpecification': tool.specification || '',
      'toolDescription': tool.description || '',
      'toolActive': tool.active !== false
    };

    Object.keys(fields).forEach(fieldId => {
      const element = document.getElementById(fieldId);
      if (element) {
        if (element.type === 'checkbox') {
          element.checked = fields[fieldId];
        } else {
          element.value = fields[fieldId];
        }
      }
    });
  }

  renderToolsTable(tools) {
    const tbody = document.getElementById('toolUsageBody');
    if (!tbody) return;

    if (tools.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" class="text-center py-4">
            <i class="bi bi-inbox" style="font-size: 3rem; color: #6c757d;"></i>
            <p class="mt-3 text-muted">No tools found in the catalog.</p>
            <button class="btn btn-primary" onclick="toolManagement.openAddModal()">
              <i class="bi bi-plus-circle me-1"></i>Add Your First Tool
            </button>
          </td>
        </tr>
      `;
      this.updateKPIs([], 0, 0, 0);
      return;
    }

    tbody.innerHTML = tools.map(tool => this.createToolRow(tool)).join('');
    this.updateKPIs(tools);
  }

  updateKPIs(tools) {
    // Calculate KPI values
    const totalTools = tools.length;
    const totalQuantity = tools.reduce((sum, tool) => sum + (tool.quantity || 0), 0);
    const lowStockItems = tools.filter(tool => 
      tool.status === 'low_stock' || 
      (tool.quantity || 0) <= (tool.minStockLevel || 3)
    ).length;
    const totalValue = tools.reduce((sum, tool) => 
      sum + ((tool.quantity || 0) * (tool.costPrice || 0)), 0
    );

    // Update KPI displays
    this.updateKPIValue('kpiEntries', totalTools);
    this.updateKPIValue('kpiQty', totalQuantity.toLocaleString());
    this.updateKPIValue('kpiLowStock', lowStockItems);
    this.updateKPIValue('kpiCost', `₱${totalValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);

    // Update KPI charts
    this.updateKPICharts(totalTools, totalQuantity, lowStockItems, totalValue);
  }

  updateKPICharts(totalTools, totalQuantity, lowStockItems, totalValue) {
    // Generate sample historical data (in real app, this would come from API)
    const historicalData = this.generateHistoricalData(totalTools, totalQuantity, lowStockItems, totalValue);
    
    // Draw sparkline charts with tool management theme colors
    this.drawSparkline('kpiEntriesChart', historicalData.tools, '#0056b3'); // Deep blue
    this.drawSparkline('kpiQtyChart', historicalData.quantity, '#007bff'); // Bright blue
    this.drawSparkline('kpiLowStockChart', historicalData.lowStock, '#ffc107'); // Warning yellow
    this.drawSparkline('kpiCostChart', historicalData.value, '#28a745'); // Success green
  }

  generateHistoricalData(currentTools, currentQty, currentLowStock, currentValue) {
    // Generate consistent, static historical data based on current values
    const points = 7; // Last 7 data points
    const tools = [];
    const quantity = [];
    const lowStock = [];
    const value = [];

    // Use a fixed seed for consistent data generation
    const seed = currentTools + currentQty + currentLowStock + Math.floor(currentValue / 1000);
    
    for (let i = 0; i < points; i++) {
      // Create consistent variations based on seed
      const variation = 0.85 + ((seed + i * 7) % 25) / 100; // 85% to 110% variation
      
      tools.push(Math.max(0, Math.floor(currentTools * variation * (0.88 + i * 0.02))));
      quantity.push(Math.max(0, Math.floor(currentQty * variation * (0.82 + i * 0.025))));
      lowStock.push(Math.max(0, Math.floor(currentLowStock * variation * (0.90 + ((seed + i * 3) % 15) / 100))));
      value.push(Math.max(0, currentValue * variation * (0.87 + i * 0.018)));
    }

    return { tools, quantity, lowStock, value };
  }

  drawSparkline(canvasId, data, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    if (data.length < 2) return;

    // Find min and max values
    const minValue = Math.min(...data);
    const maxValue = Math.max(...data);
    const range = maxValue - minValue || 1;

    // Calculate points
    const points = data.map((value, index) => ({
      x: (index / (data.length - 1)) * width,
      y: height - ((value - minValue) / range) * height * 0.8 - height * 0.1
    }));

    // Draw gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, color + '30'); // More subtle transparency
    gradient.addColorStop(1, color + '00'); // Fully transparent

    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    points.forEach(point => ctx.lineTo(point.x, point.y));
    ctx.lineTo(points[points.length - 1].x, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw line only (no points)
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.forEach((point, index) => {
      if (index > 0) ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // No data points - just the smooth line
  }

  updateKPIValue(elementId, value) {
    const element = document.getElementById(elementId);
    if (element) {
      // Animate the value change
      const currentValue = element.textContent;
      if (currentValue !== value) {
        element.style.transition = 'all 0.3s ease';
        element.style.transform = 'scale(1.1)';
        element.textContent = value;
        setTimeout(() => {
          element.style.transform = 'scale(1)';
        }, 200);
      }
    }
  }

  createToolRow(tool) {
    const statusBadge = this.getStatusBadge(tool.status);
    const activeBadge = tool.active !== false 
      ? '<span class="badge bg-success">Active</span>' 
      : '<span class="badge bg-secondary">Inactive</span>';

    return `
      <tr>
        <td>
          <div class="d-flex align-items-center">
            <div class="me-2">
              <i class="bi bi-tools text-primary"></i>
            </div>
            <div>
              <div class="fw-semibold">${tool.itemName || 'N/A'}</div>
              <small class="text-muted">ID: ${tool._id}</small>
            </div>
          </div>
        </td>
        <td><span class="badge bg-info">${tool.unit || 'N/A'}</span></td>
        <td><strong>₱${(tool.costPrice || 0).toLocaleString()}</strong></td>
        <td><strong>₱${(tool.sellingPrice || 0).toLocaleString()}</strong></td>
        <td>
          <div class="d-flex align-items-center">
            <span class="fw-bold">${tool.quantity || 0}</span>
            ${tool.quantity <= (tool.minStockLevel || 3) ? 
              '<i class="bi bi-exclamation-triangle text-warning ms-1" title="Low stock"></i>' : ''}
          </div>
        </td>
        <td>${statusBadge}</td>
        <td>${tool.minStockLevel || 3}</td>
        <td>
          <div class="small">
            ${new Date(tool.createdAt).toLocaleDateString()}
            <br>
            <span class="text-muted">${this.formatDate(tool.createdAt)}</span>
          </div>
        </td>
        <td>
          <div class="small text-truncate" style="max-width: 150px;" title="${tool.description || 'No description'}">
            ${tool.description || '<span class="text-muted">No description</span>'}
          </div>
        </td>
        <td>
          <div class="btn-group" role="group">
            <button class="btn btn-sm btn-outline-primary" onclick="toolManagement.openEditModal('${tool._id}')" title="Edit Tool">
              <i class="bi bi-pencil"></i>
            </button>
            <button class="btn btn-sm btn-outline-info" onclick="toolManagement.viewToolDetails('${tool._id}')" title="View Details">
              <i class="bi bi-eye"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger" onclick="toolManagement.deleteTool('${tool._id}')" title="Delete Tool">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }

  getStatusBadge(status) {
    const badges = {
      'in_stock': '<span class="badge bg-success">In Stock</span>',
      'low_stock': '<span class="badge bg-warning">Low Stock</span>',
      'out_of_stock': '<span class="badge bg-danger">Out of Stock</span>',
      'discontinued': '<span class="badge bg-secondary">Discontinued</span>'
    };
    return badges[status] || '<span class="badge bg-secondary">Unknown</span>';
  }

  formatDate(dateString) {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString();
  }

  updateToolCount(count) {
    const countElement = document.getElementById('toolUsageCount');
    if (countElement) {
      countElement.textContent = `${count} tools`;
    }
  }

  async saveTool() {
    if (!this.form || !this.form.checkValidity()) {
      this.form.classList.add('was-validated');
      return;
    }

    const submitBtn = document.getElementById('saveToolBtn');
    const originalText = submitBtn.innerHTML;
    
    try {
      // Show loading state
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="bi bi-hourglass-split me-1"></i>Saving...';

      const formData = new FormData(this.form);
      const toolData = Object.fromEntries(formData.entries());

      // Convert checkbox values
      toolData.isStockItem = document.getElementById('toolIsStockItem').checked;
      toolData.active = document.getElementById('toolActive').checked;

      // Convert numeric fields
      toolData.quantity = Number(toolData.quantity) || 0;
      toolData.minStockLevel = Number(toolData.minStockLevel) || 3;
      toolData.costPrice = Number(toolData.costPrice) || 0;
      toolData.sellingPrice = Number(toolData.sellingPrice) || 0;

      let response;
      if (this.currentEditId) {
        // Update existing tool
        response = await fetch(`/api/admin/tools/${this.currentEditId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(toolData)
        });
      } else {
        // Create new tool
        response = await fetch('/api/admin/tools', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(toolData)
        });
      }

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to save tool');
      }

      // Close modal and reload data
      this.hideModal();

      this.showNotification(
        this.currentEditId ? 'Tool updated successfully' : 'Tool added successfully',
        'success'
      );

      this.loadTools();
      this.currentEditId = null;

    } catch (error) {
      console.error('Error saving tool:', error);
      this.showNotification(error.message || 'Failed to save tool', 'danger');
    } finally {
      // Reset button state
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  }

  async deleteTool(toolId) {
    if (!confirm('Are you sure you want to delete this tool? This action cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/tools/${toolId}`, {
        method: 'DELETE'
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to delete tool');
      }

      this.showNotification('Tool deleted successfully', 'success');
      this.loadTools();

    } catch (error) {
      console.error('Error deleting tool:', error);
      this.showNotification(error.message || 'Failed to delete tool', 'danger');
    }
  }

  viewToolDetails(toolId) {
    // Implementation for viewing tool details in a separate modal
    console.log('View tool details:', toolId);
    // You can implement a separate modal for viewing details
  }

  showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `alert alert-${type} alert-dismissible fade show position-fixed`;
    notification.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
    notification.innerHTML = `
      <div class="d-flex align-items-center">
        <i class="bi bi-${type === 'success' ? 'check-circle' : type === 'danger' ? 'exclamation-triangle' : 'info-circle'} me-2"></i>
        <span>${message}</span>
        <button type="button" class="btn-close ms-auto" data-bs-dismiss="alert"></button>
      </div>
    `;

    document.body.appendChild(notification);

    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 5000);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.toolManagement = new ToolManagement();
});
