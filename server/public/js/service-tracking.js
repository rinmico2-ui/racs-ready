// Service Tracking Enterprise JavaScript
class ServiceTracking {
  constructor() {
    this.apiBase = window.SERVICE_TRACKING_CONTEXT?.apiBase || '/api/admin';
    this.services = [];
    this.technicians = [];
    this.serviceTypes = [];
    this.filters = {
      startDate: '',
      endDate: '',
      technician: '',
      serviceType: '',
      status: '',
      search: ''
    };
    this.init();
  }

  async init() {
    this.bindEvents();
    await this.loadData();
    this.updateKPIs();
  }

  bindEvents() {
    // Filter events
    document.getElementById('startDate')?.addEventListener('change', () => this.applyFilters());
    document.getElementById('endDate')?.addEventListener('change', () => this.applyFilters());
    document.getElementById('technicianFilter')?.addEventListener('change', () => this.applyFilters());
    document.getElementById('serviceTypeFilter')?.addEventListener('change', () => this.applyFilters());
    document.getElementById('statusFilter')?.addEventListener('change', () => this.applyFilters());
    document.getElementById('searchBtn')?.addEventListener('click', () => this.applyFilters());
    document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.applyFilters();
    });

    // Action events
    document.getElementById('resetFilters')?.addEventListener('click', () => this.resetFilters());
    document.getElementById('refreshBtn')?.addEventListener('click', () => this.refreshData());
    document.getElementById('exportBtn')?.addEventListener('click', () => this.exportData());
    document.getElementById('toggleColumns')?.addEventListener('click', () => this.toggleColumns());
  }

  async loadData() {
    try {
      await Promise.all([
        this.loadServices(),
        this.loadTechnicians(),
        this.loadServiceTypes()
      ]);
      this.populateFilters();
      this.renderServices();
    } catch (error) {
      console.error('Error loading data:', error);
      this.showError('Failed to load data');
    }
  }

  async loadServices() {
    const response = await fetch(`${this.apiBase}/service-tracking`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load services');
    this.services = data.services || [];
  }

  async loadTechnicians() {
    const response = await fetch(`${this.apiBase}/technicians`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load technicians');
    this.technicians = data.technicians || [];
  }

  async loadServiceTypes() {
    const response = await fetch(`${this.apiBase}/service-types`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load service types');
    this.serviceTypes = data.serviceTypes || [];
  }

  populateFilters() {
    // Populate technician filter
    const technicianFilter = document.getElementById('technicianFilter');
    if (technicianFilter) {
      technicianFilter.innerHTML = '<option value="">All Technicians</option>';
      this.technicians.forEach(tech => {
        const option = document.createElement('option');
        option.value = tech._id;
        option.textContent = tech.name;
        technicianFilter.appendChild(option);
      });
    }

    // Populate service type filter
    const serviceTypeFilter = document.getElementById('serviceTypeFilter');
    if (serviceTypeFilter) {
      serviceTypeFilter.innerHTML = '<option value="">All Services</option>';
      this.serviceTypes.forEach(type => {
        const option = document.createElement('option');
        option.value = type._id;
        option.textContent = type.name;
        serviceTypeFilter.appendChild(option);
      });
    }
  }

  applyFilters() {
    this.filters.startDate = document.getElementById('startDate')?.value || '';
    this.filters.endDate = document.getElementById('endDate')?.value || '';
    this.filters.technician = document.getElementById('technicianFilter')?.value || '';
    this.filters.serviceType = document.getElementById('serviceTypeFilter')?.value || '';
    this.filters.status = document.getElementById('statusFilter')?.value || '';
    this.filters.search = document.getElementById('searchInput')?.value || '';

    this.renderServices();
    this.updateKPIs();
  }

  resetFilters() {
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';
    document.getElementById('technicianFilter').value = '';
    document.getElementById('serviceTypeFilter').value = '';
    document.getElementById('statusFilter').value = '';
    document.getElementById('searchInput').value = '';
    
    this.filters = {
      startDate: '',
      endDate: '',
      technician: '',
      serviceType: '',
      status: '',
      search: ''
    };

    this.renderServices();
    this.updateKPIs();
  }

  getFilteredServices() {
    return this.services.filter(service => {
      // Date filter
      if (this.filters.startDate && service.date) {
        const serviceDate = new Date(service.date);
        const startDate = new Date(this.filters.startDate);
        if (serviceDate < startDate) return false;
      }
      if (this.filters.endDate && service.date) {
        const serviceDate = new Date(service.date);
        const endDate = new Date(this.filters.endDate);
        endDate.setHours(23, 59, 59, 999);
        if (serviceDate > endDate) return false;
      }

      // Technician filter
      if (this.filters.technician && service.technicianId !== this.filters.technician) {
        return false;
      }

      // Service type filter
      if (this.filters.serviceType && service.serviceTypeId !== this.filters.serviceType) {
        return false;
      }

      // Status filter
      if (this.filters.status && service.status !== this.filters.status) {
        return false;
      }

      // Search filter
      if (this.filters.search) {
        const searchLower = this.filters.search.toLowerCase();
        return (
          service.bookingId?.toLowerCase().includes(searchLower) ||
          service.customerName?.toLowerCase().includes(searchLower) ||
          service.technicianName?.toLowerCase().includes(searchLower) ||
          service.toolUsages?.some(tool => tool.toolName?.toLowerCase().includes(searchLower))
        );
      }

      return true;
    });
  }

  renderServices() {
    const tbody = document.getElementById('serviceTableBody');
    const filteredServices = this.getFilteredServices();
    
    if (!tbody) return;

    if (filteredServices.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="11" class="text-center py-4">
            <i class="bi bi-search" style="font-size: 2rem; color: #6c757d;"></i>
            <p class="mt-2 text-muted">No services found matching your criteria</p>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filteredServices.map(service => this.createServiceRow(service)).join('');
    
    // Update record count
    const recordCount = document.getElementById('recordCount');
    if (recordCount) {
      recordCount.textContent = `${filteredServices.length} records`;
    }

    // Bind detail modal events
    this.bindDetailEvents();
  }

  createServiceRow(service) {
    const statusBadge = this.getStatusBadge(service.status);
    const toolsUsed = service.toolUsages?.length || 0;
    const totalCost = this.calculateTotalCost(service);
    const duration = this.calculateDuration(service);

    return `
      <tr>
        <td>
          <strong>${service.bookingId || 'N/A'}</strong>
          <br>
          <small class="text-muted">${this.formatDate(service.date)}</small>
        </td>
        <td>${this.formatDate(service.date)}</td>
        <td>
          <div class="d-flex align-items-center">
            <i class="bi bi-person-circle me-2"></i>
            <div>
              <div>${service.customerName || 'N/A'}</div>
              <small class="text-muted">${service.customerPhone || ''}</small>
            </div>
          </div>
        </td>
        <td>
          <div class="d-flex align-items-center">
            <i class="bi bi-person-workspace me-2"></i>
            ${service.technicianName || 'N/A'}
          </div>
        </td>
        <td>
          <span class="badge bg-info">${service.serviceTypeName || 'N/A'}</span>
        </td>
        <td>${statusBadge}</td>
        <td>
          ${toolsUsed > 0 ? `
            <span class="badge bg-primary">${toolsUsed} tools</span>
            <br>
            <small class="text-muted">Click to view</small>
          ` : '<span class="text-muted">No tools</span>'}
        </td>
        <td>
          <strong>₱${totalCost.toLocaleString()}</strong>
        </td>
        <td>
          <strong>₱${(service.travelFare || 0).toLocaleString()}</strong>
        </td>
        <td>
          <div class="d-flex align-items-center">
            <i class="bi bi-clock me-1"></i>
            ${duration}
          </div>
        </td>
        <td>
          <div class="btn-group" role="group">
            <button class="btn btn-sm btn-outline-primary" onclick="serviceTracking.showServiceDetail('${service._id}')" title="View Details">
              <i class="bi bi-eye"></i>
            </button>
            <button class="btn btn-sm btn-outline-secondary" onclick="serviceTracking.exportService('${service._id}')" title="Export">
              <i class="bi bi-download"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }

  getStatusBadge(status) {
    const badges = {
      completed: '<span class="status-badge-enterprise bg-success">Completed</span>',
      'in-progress': '<span class="status-badge-enterprise bg-warning">In Progress</span>',
      scheduled: '<span class="status-badge-enterprise bg-info">Scheduled</span>',
      cancelled: '<span class="status-badge-enterprise bg-danger">Cancelled</span>'
    };
    return badges[status] || '<span class="status-badge-enterprise bg-secondary">Unknown</span>';
  }

  calculateTotalCost(service) {
    let total = 0;
    if (service.toolUsages) {
      service.toolUsages.forEach(tool => {
        total += tool.totalCost || 0;
      });
    }
    if (service.serviceCost) {
      total += service.serviceCost;
    }
    return total || 0;
  }

  calculateDuration(service) {
    if (!service.startTime || !service.endTime) return 'N/A';
    
    const start = new Date(service.startTime);
    const end = new Date(service.endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return 'N/A';

    const diffMs = end - start;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (diffHours > 0) {
      return `${diffHours}h ${diffMins}m`;
    } else {
      return `${diffMins}m`;
    }
  }

  formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  updateKPIs() {
    const filteredServices = this.getFilteredServices();
    
    // Total Services
    const totalServices = filteredServices.length;
    const servicesElement = document.getElementById('totalServices');
    if (servicesElement) {
      servicesElement.textContent = totalServices.toLocaleString();
    }

    // Total Tool Usage
    const totalTools = filteredServices.reduce((sum, service) => {
      return sum + (service.toolUsages?.length || 0);
    }, 0);
    const toolsElement = document.getElementById('totalToolUsage');
    if (toolsElement) {
      toolsElement.textContent = totalTools.toLocaleString();
    }

    // Total Cost
    const totalCost = filteredServices.reduce((sum, service) => {
      return sum + this.calculateTotalCost(service);
    }, 0);
    const costElement = document.getElementById('totalCost');
    if (costElement) {
      costElement.textContent = `₱${totalCost.toLocaleString()}`;
    }

    // Active Technicians
    const activeTechs = new Set(filteredServices.map(s => s.technicianId).filter(Boolean));
    const techsElement = document.getElementById('activeTechnicians');
    if (techsElement) {
      techsElement.textContent = activeTechs.size.toLocaleString();
    }

    // Update growth indicators (mock data for now)
    this.updateGrowthIndicators();

    // Update sparkline mini charts inside KPI cards
    this.updateSparklines(filteredServices);
  }

  updateGrowthIndicators() {
    // Mock growth data - in real implementation, calculate from historical data
    document.getElementById('servicesGrowth').textContent = '+12%';
    document.getElementById('toolsGrowth').textContent = '+8%';
    document.getElementById('costGrowth').textContent = '+5%';
    document.getElementById('techActivity').textContent = '+3 online';
  }

  updateSparklines(filteredServices) {
    // Generate light sparkline data; use service counts over last 7 days (fallback random pattern for empty service set)
    const today = new Date();
    const days = 7;
    const values = Array.from({ length: days }, (_, i) => {
      const targetDate = new Date(today);
      targetDate.setDate(today.getDate() - (days - 1 - i));
      const count = filteredServices.filter(s => {
        if (!s.date) return false;
        const d = new Date(s.date);
        return (
          d.getFullYear() === targetDate.getFullYear() &&
          d.getMonth() === targetDate.getMonth() &&
          d.getDate() === targetDate.getDate()
        );
      }).length;
      return count;
    });

    const toolsSeries = this.createHistorySeries(filteredServices.reduce((sum, s) => sum + (s.toolUsages?.length || 0), 0), 7);
    const costSeries = this.createHistorySeries(filteredServices.reduce((sum, s) => sum + this.calculateTotalCost(s), 0), 7);
    const techsSeries = this.createHistorySeries(new Set(filteredServices.map(s => s.technicianId).filter(Boolean)).size, 7);

    this.drawSparkline('kpiSparkTotalServices', values.length ? values : [0,0,1,2,1,3,2], '#0d6efd');
    this.drawSparkline('kpiSparkToolsUsed', toolsSeries, '#198754');
    this.drawSparkline('kpiSparkTotalCost', costSeries, '#ffc107');
    this.drawSparkline('kpiSparkActiveTechnicians', techsSeries, '#6f42c1');
  }

  createHistorySeries(base, length) {
    const series = [];
    const delta = Math.max(1, Math.round(base * 0.08));
    for (let i = 0; i < length; i++) {
      const variance = Math.round((Math.sin(i / 2) * 0.2 + 1) * 0.5 * delta);
      series.push(Math.max(0, Math.round(base * (0.65 + (i / length * 0.35))) + variance));
    }
    return series;
  }

  drawSparkline(canvasId, data, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width || canvas.offsetWidth || 180;
    const height = canvas.height || canvas.offsetHeight || 42;
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    if (!Array.isArray(data) || data.length < 2) return;

    const minValue = Math.min(...data);
    const maxValue = Math.max(...data);
    const range = maxValue - minValue || 1;

    const points = data.map((value, index) => ({
      x: (index / (data.length - 1)) * width,
      y: height - ((value - minValue) / range) * (height * 0.8) - height * 0.1
    }));

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `${color}40`);
    gradient.addColorStop(1, `${color}00`);

    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  async showServiceDetail(serviceId) {
    try {
      const response = await fetch(`${this.apiBase}/service-tracking/${serviceId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load service details');
      
      this.renderServiceDetail(data.service);
      
      const modal = new bootstrap.Modal(document.getElementById('serviceDetailModal'));
      modal.show();
    } catch (error) {
      console.error('Error loading service details:', error);
      this.showError('Failed to load service details');
    }
  }

  renderServiceDetail(service) {
    const content = document.getElementById('serviceDetailContent');
    if (!content) return;

    const toolUsageHtml = service.toolUsages?.map(tool => `
      <div class="tool-usage-chip">
        <strong>${tool.toolName}</strong> - ${tool.quantityUsed} ${tool.unit} (₱${tool.totalCost})
      </div>
    `).join('') || '<p class="text-muted">No tools used</p>';

    const costBreakdown = this.createCostBreakdown(service);

    content.innerHTML = `
      <div class="row">
        <div class="col-md-6">
          <h6><i class="bi bi-info-circle me-2"></i>Service Information</h6>
          <table class="table table-sm">
            <tr>
              <td><strong>Booking ID:</strong></td>
              <td>${service.bookingId || 'N/A'}</td>
            </tr>
            <tr>
              <td><strong>Date:</strong></td>
              <td>${this.formatDate(service.date)}</td>
            </tr>
            <tr>
              <td><strong>Customer:</strong></td>
              <td>${service.customerName || 'N/A'}</td>
            </tr>
            <tr>
              <td><strong>Technician:</strong></td>
              <td>${service.technicianName || 'N/A'}</td>
            </tr>
            <tr>
              <td><strong>Service Type:</strong></td>
              <td>${service.serviceTypeName || 'N/A'}</td>
            </tr>
            <tr>
              <td><strong>Status:</strong></td>
              <td>${this.getStatusBadge(service.status)}</td>
            </tr>
            <tr>
              <td><strong>Duration:</strong></td>
              <td>${this.calculateDuration(service)}</td>
            </tr>
          </table>
        </div>
        <div class="col-md-6">
          <h6><i class="bi bi-tools me-2"></i>Tools Used</h6>
          <div class="mb-3">
            ${toolUsageHtml}
          </div>
          
          <h6><i class="bi bi-currency-dollar me-2"></i>Cost Breakdown</h6>
          ${costBreakdown}
        </div>
      </div>
      
      ${service.notes ? `
        <div class="row mt-3">
          <div class="col-12">
            <h6><i class="bi bi-chat-left-text me-2"></i>Notes</h6>
            <p class="text-muted">${service.notes}</p>
          </div>
        </div>
      ` : ''}
    `;
  }

  createCostBreakdown(service) {
    let serviceCost = service.serviceCost || 0;
    let toolCosts = 0;
    let fuelCosts = 0;

    if (service.toolUsages) {
      service.toolUsages.forEach(tool => {
        toolCosts += tool.toolCost || 0;
        fuelCosts += tool.fuelUsed || 0;
      });
    }

    // Add travel fare to fuel costs
    fuelCosts += service.travelFare || 0;

    const total = serviceCost + toolCosts + fuelCosts;

    return `
      <div class="cost-breakdown">
        <div class="cost-item">
          <span>Service Cost:</span>
          <span>₱${serviceCost.toLocaleString()}</span>
        </div>
        <div class="cost-item">
          <span>Tool Costs:</span>
          <span>₱${toolCosts.toLocaleString()}</span>
        </div>
        <div class="cost-item">
          <span>Fuel Costs (including travel):</span>
          <span>₱${fuelCosts.toLocaleString()}</span>
        </div>
        <div class="cost-item">
          <span>Total:</span>
          <span>₱${total.toLocaleString()}</span>
        </div>
      </div>
    `;
  }

  async exportService(serviceId) {
    try {
      const response = await fetch(`${this.apiBase}/service-tracking/${serviceId}/export`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `service-${serviceId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting service:', error);
      this.showError('Failed to export service');
    }
  }

  async exportData() {
    try {
      const filteredServices = this.getFilteredServices();
      const response = await fetch(`${this.apiBase}/service-tracking/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ services: filteredServices }),
      });
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `service-tracking-${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting data:', error);
      this.showError('Failed to export data');
    }
  }

  async refreshData() {
    const btn = document.getElementById('refreshBtn');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise me-2"></i>Loading...';
    btn.disabled = true;

    try {
      await this.loadData();
      this.updateKPIs();
    } catch (error) {
      console.error('Error refreshing data:', error);
      this.showError('Failed to refresh data');
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }

  toggleColumns() {
    // Implementation for toggling table columns
    const table = document.getElementById('serviceTable');
    const columns = table.querySelectorAll('th');
    // Add column toggle logic here
  }

  bindDetailEvents() {
    // Bind any additional events for the detail modal
  }

  showError(message) {
    // Simple error notification - replace with your preferred notification system
    const alert = document.createElement('div');
    alert.className = 'alert alert-danger alert-dismissible fade show';
    alert.innerHTML = `
      ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    document.querySelector('.container-fluid').prepend(alert);
    
    setTimeout(() => {
      alert.remove();
    }, 5000);
  }
}

// Initialize the service tracking when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.serviceTracking = new ServiceTracking();
});
