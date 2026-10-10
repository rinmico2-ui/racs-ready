"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const currentUser = require('../middleware/currentUser');
const auth = require('../middleware/authenticate');
const pageAuth = require('../middleware/pageAuth');
const controller = require('../controllers/authController');
const { isSessionCurrent } = require('../utils/sessionPasswordPolicy');

const changedAt = new Date('2026-10-09T10:00:00Z');
const account = { _id:'507f1f77bcf86cd799439011', role:'customer', active:true, blocked:false, permissionsOverridden:true, permissions:[], lastPasswordChange:changedAt };
const session = createdAt => ({ userId:account._id, createdAt, destroy(callback){ callback(); } });
function response() {
  return { locals:{}, statusCode:200, status(code){ this.statusCode=code;return this; },
    set(){}, clearCookie(){}, json(body){ this.body=body;return this; }, redirect(url){ this.redirectUrl=url; } };
}

test('password changes revoke older and undated sessions, while fresh logins work', () => {
  assert.equal(isSessionCurrent(session(changedAt.getTime()-1),account),false);
  assert.equal(isSessionCurrent(session(undefined),account),false);
  assert.equal(isSessionCurrent(session(changedAt.getTime()),account),true);
  assert.equal(isSessionCurrent(session(changedAt.getTime()+1),account),true);
  assert.equal(isSessionCurrent(session(undefined),{ ...account,lastPasswordChange:null }),true);
});

test('all session fallback paths reject sessions predating a password change', async () => {
  const original = User.findById;
  User.findById = () => ({ select:async()=>account });
  try {
    for (const createdAt of [changedAt.getTime()-1, changedAt.getTime()+1]) {
      const valid = createdAt > changedAt.getTime();
      let req={ headers:{}, session:session(createdAt) },res=response();
      await currentUser(req,res,()=>{});
      assert.equal(!!req.user,valid,'global identity');
      req={ headers:{}, session:session(createdAt) };res=response();let passed=false;
      await auth.authenticate(req,res,e=>{if(e)throw e;passed=true;});
      assert.equal(passed,valid,'API authentication');
      req={ headers:{}, originalUrl:'/profile', session:session(createdAt) };res=response();passed=false;
      await pageAuth.requireRole('customer')(req,res,()=>{passed=true;});
      assert.equal(passed,valid,'page authentication');
      req={ headers:{}, session:session(createdAt) };res=response();
      await controller.verify(req,res);
      assert.equal(!!res.body.user,valid,'session verification');
    }
  } finally { User.findById=original; }
});
