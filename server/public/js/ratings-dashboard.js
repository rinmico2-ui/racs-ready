(function(){
  'use strict';
  var D={},charts={};

  document.addEventListener('DOMContentLoaded',loadDashboard);

  async function loadDashboard(){
    try{
      var res=await fetch('/api/admin/ratings/dashboard',{credentials:'same-origin'});
      if(!res.ok){
        var errText='HTTP '+res.status;
        try{var errBody=await res.json();if(errBody.error)errText=errBody.error;}catch(x){}
        throw new Error(errText);
      }
      D=await res.json();
      renderAll();
    }catch(e){
      console.error('Dashboard load error:',e);
      showError('Failed to load dashboard: '+e.message);
    }
  }

  function showError(msg){
    ['totalRatings','avgRating','responseRate','lowRatingCount'].forEach(function(id){
      var el=document.getElementById(id);if(el)el.textContent='--';
    });
    var containers=['complaintsContainer','topTechContainer','lowestTechContainer','serviceRatingsContainer','insightsContainer'];
    containers.forEach(function(id){
      var el=document.getElementById(id);if(el)el.innerHTML='<div class="text-center text-danger py-3"><i class="bi bi-exclamation-triangle d-block mb-2 fs-4"></i>'+msg+'</div>';
    });
    var rc=document.getElementById('recentReviewsContainer');if(rc)rc.innerHTML='<div class="col-12 text-center py-4 text-danger">'+msg+'</div>';
    var rt=document.getElementById('recentRatingsTable');if(rt)rt.innerHTML='<tr><td colspan="7" class="text-center py-4 text-danger">'+msg+'</td></tr>';
  }

  function renderAll(){
    renderKPIs();renderTrend();renderDistribution();renderSentiment();
    renderAlerts();renderComplaints();renderTopTechnicians();renderLowestTechnicians();
    renderServiceRatings();renderInsights();renderReviewSources();
    renderRecentReviews();renderRatingsTable();
  }

  function renderKPIs(){
    var s=D.stats||{};
    document.getElementById('totalRatings').textContent=s.totalRatings||0;
    document.getElementById('avgRating').textContent=(s.avgRating||0).toFixed(1);
    document.getElementById('responseRate').textContent=s.responseRate||0;
    document.getElementById('lowRatingCount').textContent=s.lowRatingCount||0;
    var change=D.ratingChange||0,badge=document.getElementById('ratingChangeBadge');
    if(badge){
      if(change>0){badge.className='badge bg-success-subtle text-success fs-7';badge.innerHTML='<i class="bi bi-arrow-up-short"></i>+'+change.toFixed(1);}
      else if(change<0){badge.className='badge bg-danger-subtle text-danger fs-7';badge.innerHTML='<i class="bi bi-arrow-down-short"></i>'+change.toFixed(1);}
      else{badge.className='badge bg-secondary-subtle text-secondary fs-7';badge.innerHTML='<i class="bi bi-dash"></i>0';}
    }
    updateStarDisplay(s.avgRating||0);
  }

  function updateStarDisplay(rating){
    var el=document.getElementById('starDisplay');if(!el)return;var html='';
    for(var i=1;i<=5;i++){
      if(i<=Math.floor(rating))html+='<i class="bi bi-star-fill text-warning"></i>';
      else if(i===Math.ceil(rating)&&rating%1!==0)html+='<i class="bi bi-star-half text-warning"></i>';
      else html+='<i class="bi bi-star text-warning"></i>';
    }
    el.innerHTML=html;
  }

  function renderTrend(){
    var trend=D.trend||{},labels=trend.labels||[],data=trend.data||[],counts=trend.counts||[];
    var canvas=document.getElementById('ratingTrendsChart');if(!canvas)return;
    var ctx=canvas.getContext('2d');
    var cfg={type:'line',data:{labels:labels,datasets:[
      {label:'Average Rating',data:data,borderColor:'#0d6efd',backgroundColor:'rgba(13,110,253,.08)',fill:true,tension:.4,pointRadius:5,pointHoverRadius:7,yAxisID:'y'},
      {label:'Review Count',data:counts,borderColor:'#198754',backgroundColor:'rgba(25,135,84,.08)',borderDash:[5,5],tension:.4,pointRadius:3,yAxisID:'y1'}
    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},scales:{y:{beginAtZero:false,min:0,max:5,title:{display:true,text:'Avg Rating'}},y1:{beginAtZero:true,position:'right',grid:{drawOnChartArea:false},title:{display:true,text:'Count'}}}}};
    if(charts.trend)charts.trend.destroy();charts.trend=new Chart(ctx,cfg);
  }

  function renderDistribution(){
    var dist=D.distribution||{};
    var labels=['5 Stars','4 Stars','3 Stars','2 Stars','1 Star'];
    var data=[dist['5']||0,dist['4']||0,dist['3']||0,dist['2']||0,dist['1']||0];
    var colors=['#198754','#0d6efd','#ffc107','#fd7e14','#dc3545'];
    var canvas=document.getElementById('ratingDistributionChart');if(!canvas)return;
    var ctx=canvas.getContext('2d');
    var cfg={type:'bar',data:{labels:labels,datasets:[{data:data,backgroundColor:colors,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true}}}};
    if(charts.dist)charts.dist.destroy();charts.dist=new Chart(ctx,cfg);
  }

  function renderSentiment(){
    var sent=D.sentiment||{},total=(sent.positive||0)+(sent.neutral||0)+(sent.negative||0)||1;
    document.getElementById('sentimentScore').textContent=sent.sentimentScore||0;
    document.getElementById('sentimentPos').textContent=sent.positive||0;
    document.getElementById('sentimentNeu').textContent=sent.neutral||0;
    document.getElementById('sentimentNeg').textContent=sent.negative||0;
    document.getElementById('sentimentPosBar').style.width=Math.round(((sent.positive||0)/total)*100)+'%';
    document.getElementById('sentimentNeuBar').style.width=Math.round(((sent.neutral||0)/total)*100)+'%';
    document.getElementById('sentimentNegBar').style.width=Math.round(((sent.negative||0)/total)*100)+'%';
  }

  function renderAlerts(){
    var a=D.reviewAlerts||{};
    document.getElementById('alertLowRating').textContent=a.lowRatingReviews||0;
    document.getElementById('alertNoResponse').textContent=a.noResponseReviews||0;
    document.getElementById('alertFlagged').textContent=a.flaggedReviews||0;
  }

  function renderComplaints(){
    var c=document.getElementById('complaintsContainer'),complaints=D.complaintCategories||[];
    if(!complaints.length){c.innerHTML='<div class="text-center text-muted py-3">No complaints found</div>';return;}
    var max=Math.max.apply(null,complaints.map(function(x){return x.count;}))||1;
    c.innerHTML=complaints.map(function(x){
      return '<div class="complaint-item"><div><div class="fw-semibold" style="font-size:.9rem">'+x.name+'</div></div><div class="d-flex align-items-center gap-2"><div style="width:80px;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden"><div style="width:'+Math.round((x.count/max)*100)+'%;height:100%;background:#dc3545;border-radius:3px"></div></div><span class="badge bg-danger-subtle text-danger">'+x.count+'</span></div></div>';
    }).join('');
  }

  function renderTopTechnicians(){
    var c=document.getElementById('topTechContainer'),techs=D.topTechnicians||[];
    if(!techs.length){c.innerHTML='<div class="text-center text-muted py-3">No technician ratings yet</div>';return;}
    var colors=['#0d6efd','#198754','#ffc107','#0dcaf0','#6f42c1'];
    c.innerHTML=techs.map(function(t,i){
      return '<div class="d-flex align-items-center gap-3 mb-3"><div class="tech-avatar" style="background:'+colors[i%colors.length]+'">'+t.name.charAt(0)+'</div><div class="flex-grow-1"><div class="fw-semibold">'+t.name+'</div><small class="text-muted">'+t.reviewCount+' review'+(t.reviewCount!==1?'s':'')+'</small></div><div class="text-end"><span class="fw-bold text-warning">'+t.avgRating+'&#9733;</span></div></div>';
    }).join('');
  }

  function renderLowestTechnicians(){
    var c=document.getElementById('lowestTechContainer'),techs=D.lowestTechnicians||[];
    if(!techs.length){c.innerHTML='<div class="text-center text-muted py-3">No low-rated technicians</div>';return;}
    c.innerHTML=techs.map(function(t){
      var isLow=t.avgRating<3;
      return '<div class="d-flex align-items-center gap-3 mb-3"><div class="tech-avatar" style="background:'+(isLow?'#dc3545':'#fd7e14')+'">'+t.name.charAt(0)+'</div><div class="flex-grow-1"><div class="fw-semibold">'+t.name+'</div><small class="text-muted">'+t.reviewCount+' review'+(t.reviewCount!==1?'s':'')+'</small></div><div class="text-end"><span class="fw-bold '+(isLow?'text-danger':'text-warning')+'">'+t.avgRating+'&#9733;</span><div><small class="text-muted">Needs coaching</small></div></div></div>';
    }).join('');
  }

  function renderServiceRatings(){
    var c=document.getElementById('serviceRatingsContainer'),services=D.serviceRatings||[];
    if(!services.length){c.innerHTML='<div class="text-center text-muted py-3">No service ratings yet</div>';return;}
    var barColors={'Cleaning':'#0d6efd','Installation':'#198754','Repair':'#dc3545','Maintenance':'#ffc107','Inspection':'#0dcaf0'};
    c.innerHTML=services.map(function(s){
      var pct=Math.round((s.avgRating/5)*100),color=barColors[s.name]||'#6c757d';
      return '<div class="service-bar-row"><div class="service-bar-label">'+s.name+'</div><div class="service-bar-track"><div class="service-bar-fill" style="width:'+pct+'%;background:'+color+'"></div></div><div class="service-bar-value">'+s.avgRating+'&#9733;</div></div>';
    }).join('');
  }

  function renderInsights(){
    var c=document.getElementById('insightsContainer'),insights=D.insights||[];
    if(!insights.length){c.innerHTML='<div class="text-center text-muted py-3">No insights available</div>';return;}
    var colors=['#0d6efd','#198754','#ffc107','#dc3545','#0dcaf0'];
    c.innerHTML=insights.map(function(ins,i){
      return '<div class="insight-item"><div class="insight-bullet" style="background:'+colors[i%colors.length]+'"></div><div>'+ins+'</div></div>';
    }).join('');
  }

  function renderReviewSources(){
    var src=D.reviewSources||{},labels=[],data=[],colors=['#0d6efd','#ffc107','#198754'];
    if(src.completedBooking>0){labels.push('Completed Booking');data.push(src.completedBooking);}
    if(src.productReview>0){labels.push('Product Review');data.push(src.productReview);}
    if(src.technicianReview>0){labels.push('Technician Review');data.push(src.technicianReview);}
    if(!data.length)return;
    var canvas=document.getElementById('reviewSourcesChart');if(!canvas)return;
    var ctx=canvas.getContext('2d');
    var cfg={type:'doughnut',data:{labels:labels,datasets:[{data:data,backgroundColor:colors.slice(0,data.length)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}}}};
    if(charts.sources)charts.sources.destroy();charts.sources=new Chart(ctx,cfg);
  }

  function renderRecentReviews(){
    var c=document.getElementById('recentReviewsContainer'),reviews=D.recentReviews||[];
    if(!reviews.length){c.innerHTML='<div class="col-12 text-center py-4 text-muted">No reviews yet</div>';return;}
    c.innerHTML=reviews.slice(0,6).map(function(r){
      var stars='';for(var i=1;i<=5;i++){stars+=i<=r.score?'<i class="bi bi-star-fill text-warning"></i>':i-0.5<=r.score?'<i class="bi bi-star-half text-warning"></i>':'<i class="bi bi-star text-warning"></i>';}
      var priColor=r.priority==='high'?'danger':r.priority==='medium'?'warning':'success';
      return '<div class="col-lg-4 col-md-6"><div class="review-card"><div class="d-flex justify-content-between align-items-start mb-2"><div><strong>'+r.customer+'</strong><div style="font-size:.8rem" class="text-muted">'+(r.serviceName||'')+(r.technicianName?' &middot; '+r.technicianName:'')+'</div></div><span class="badge bg-'+priColor+'-subtle text-'+priColor+'">'+r.priority+'</span></div><div class="mb-2">'+stars+'</div><p class="mb-1" style="font-size:.9rem">'+(r.comment||'<em class="text-muted">No comment</em>')+'</p><small class="text-muted">'+(r.date?new Date(r.date).toLocaleDateString():'')+'</small></div></div>';
    }).join('');
  }

  function renderRatingsTable(){
    var tbody=document.getElementById('recentRatingsTable'),reviews=D.recentReviews||[];
    var filter=document.getElementById('ratingFilter').value;
    var filtered=filter==='all'?reviews:reviews.filter(function(r){return r.type===filter;});
    if(!filtered.length){tbody.innerHTML='<tr><td colspan="7" class="text-center py-4"><div class="text-muted"><i class="bi bi-star fs-1 d-block mb-2"></i>No ratings found</div></td></tr>';return;}
    tbody.innerHTML=filtered.map(function(r){
      var stars='';for(var i=1;i<=5;i++){stars+=i<=r.score?'<i class="bi bi-star-fill text-warning"></i>':i-0.5<=r.score?'<i class="bi bi-star-half text-warning"></i>':'<i class="bi bi-star text-warning"></i>';}
      var priColor=r.priority==='high'?'danger':r.priority==='medium'?'warning':'success';
      var priLabel=r.priority==='high'?'High':r.priority==='medium'?'Medium':'Low';
      return '<tr><td>'+r.customer+'</td><td><span class="badge bg-primary-subtle text-primary">'+(r.serviceName||r.type)+'</span></td><td>'+(r.technicianName||'<span class="text-muted">N/A</span>')+'</td><td><div class="rating-stars">'+stars+'</div></td><td><div class="text-truncate" style="max-width:200px" title="'+(r.comment||'')+'">'+(r.comment||'No comment')+'</div></td><td><span class="badge bg-'+priColor+'-subtle text-'+priColor+'">'+priLabel+'</span></td><td>'+(r.date?new Date(r.date).toLocaleDateString():'')+'</td></tr>';
    }).join('');
  }

  document.getElementById('ratingFilter').addEventListener('change',renderRatingsTable);

  window.refreshDashboard=function(){loadDashboard();};
  window.exportRatingsData=function(){alert('Export functionality would be implemented here');};
})();
