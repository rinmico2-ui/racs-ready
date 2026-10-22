'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const route = require('../public/js/technician-order-route');

test('order navigation uses the saved delivery pin in GeoJSON, direct and legacy coordinate shapes', () => {
  for (const coordinates of [{type:'Point',coordinates:[120.9,15.4]},{lat:15.4,lng:120.9},[120.9,15.4]]) {
    assert.deepEqual(route.destinationFor({delivery:{coordinates}}),{lat:15.4,lng:120.9});
  }
  assert.deepEqual(route.destinationFor({delivery:{coordinates:{type:'Point',coordinates:[0,0]}}}),{lat:0,lng:0});
});

test('missing, partial and invalid customer coordinates are not converted into a zero-coordinate route', () => {
  for (const coordinates of [null,{},[],[null,null],['',''],[121,95],{lat:null,lng:121},{lat:15,lng:''},{lat:'bad',lng:121}]) {
    assert.equal(route.destinationFor({delivery:{coordinates}}),null);
  }
});

test('directions fall back to the saved address without inventing a customer pin or origin', () => {
  const href=route.directionsFor({delivery:{address:'Puncan, Carranglan & nearby gate'}});
  const url=new URL(href);
  assert.equal(url.origin,'https://www.google.com');
  assert.equal(url.searchParams.get('destination'),'Puncan, Carranglan & nearby gate');
  assert.equal(url.searchParams.has('origin'),false);
  assert.equal(route.directionsFor({delivery:{}}),null);
});

test('device directions keep latitude and longitude in navigation order and safely encode unusual addresses', () => {
  const url=new URL(route.directionsFor({delivery:{coordinates:{coordinates:[121,15]}}},{lat:14,lng:120}));
  assert.equal(url.searchParams.get('destination'),'15,121');
  assert.equal(url.searchParams.get('origin'),'14,120');
  assert.equal(url.searchParams.get('travelmode'),'driving');
  const malicious=route.directionsFor({delivery:{address:'<script>location="https://example.test"</script>'}});
  assert.ok(malicious.startsWith('https://www.google.com/maps/dir/?'));
  assert.ok(!malicious.includes('<script>'));
});
