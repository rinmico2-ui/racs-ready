const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateAssistantReport,
  validateAssistantResult,
} = require('../utils/aiTechnicianAssistant');

const unitInfo = {
  unitType: 'Split-Type Air Conditioner',
  brand: 'LG',
  model: 'Dual Inverter',
  problemDescription: 'Hindi lumalamig at may tumutulong tubig',
};

function validResult(summary = 'Preliminary assessment') {
  return {
    technicianAssistant: {
      summary,
      probableCauses: [{ cause: 'Blocked drain line', likelihood: 'high', explanation: 'Water cannot drain.' }],
      inspectionChecklist: [{ step: 1, action: 'Inspect the drain line', whatToLookFor: 'Blockage', expectedTool: 'Flashlight' }],
      suggestedTools: [{ name: 'Flashlight', purpose: 'Inspect the drain path' }],
      possibleParts: [],
      repairComplexity: 'low',
      repairApproach: 'immediate',
      estimatedDurationMinutes: 45,
      safetyReminders: ['Disconnect power before opening the unit.'],
      additionalNotes: 'Verify all findings on site.',
      preventiveMaintenance: ['Clean the drain line regularly.'],
    },
  };
}

const webResearch = {
  webContext: '\n## UNTRUSTED WEB RESEARCH\n<web_research>manufacturer reference</web_research>',
  sources: ['https://example.com/manual'],
  searchUsed: true,
};

test('Gemini processes Tavily context and receives truthful grounding metadata', async () => {
  let receivedPrompt = '';
  const result = await generateAssistantReport(unitInfo, null, {
    searchDiagnostics: async () => webResearch,
    generateWithGemini: async prompt => {
      receivedPrompt = prompt;
      return validResult('Gemini assessment');
    },
    generateWithGroq: async () => {
      throw new Error('Groq should not be called');
    },
  });

  assert.match(receivedPrompt, /<web_research>manufacturer reference<\/web_research>/);
  assert.equal(result.technicianAssistant._source, 'ai');
  assert.equal(result.technicianAssistant._provider, 'gemini');
  assert.equal(result.technicianAssistant._webResearchFetched, true);
  assert.equal(result.technicianAssistant._webResearchUsed, true);
  assert.deepEqual(result.technicianAssistant._webSources, webResearch.sources);
});

test('an invalid Gemini response falls through to a valid Groq response', async () => {
  let groqCalled = false;
  const result = await generateAssistantReport(unitInfo, null, {
    searchDiagnostics: async () => webResearch,
    generateWithGemini: async () => ({ technicianAssistant: { summary: 'Incomplete' } }),
    generateWithGroq: async () => {
      groqCalled = true;
      return validResult('Groq assessment');
    },
  });

  assert.equal(groqCalled, true);
  assert.equal(result.technicianAssistant._source, 'ai-groq');
  assert.equal(result.technicianAssistant._provider, 'groq');
  assert.equal(result.technicianAssistant._webResearchUsed, true);
});

test('local fallback never claims Tavily grounding when no LLM processed it', async () => {
  const result = await generateAssistantReport(unitInfo, null, {
    searchDiagnostics: async () => webResearch,
    generateWithGemini: async () => { throw new Error('Gemini unavailable'); },
    generateWithGroq: async () => { throw new Error('Groq unavailable'); },
  });

  assert.equal(result.technicianAssistant._source, 'fallback');
  assert.equal(result.technicianAssistant._provider, 'local');
  assert.equal(result.technicianAssistant._webResearchFetched, true);
  assert.equal(result.technicianAssistant._webResearchUsed, false);
  assert.deepEqual(result.technicianAssistant._webSources, webResearch.sources);
});

test('validation rejects unsafe categorical and duration values', () => {
  const invalid = validResult();
  invalid.technicianAssistant.repairComplexity = 'extreme';
  invalid.technicianAssistant.estimatedDurationMinutes = -1;
  assert.throws(() => validateAssistantResult(invalid), /repairComplexity/);
});
