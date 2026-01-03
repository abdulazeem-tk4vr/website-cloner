// Model configuration - switch between providers
// Set ARCHITECT_MODEL, CODER_MODEL, QA_MODEL in .env.local to switch
// Options: 'claude' | 'gemini' | 'openai' for architect/coder, 'gpt-4o' | 'gemini' for QA
export const MODEL_CONFIG = {
  // Architect & Coder models: 'claude' | 'gemini' | 'openai'
  architectModel: (process.env.ARCHITECT_MODEL || 'gemini') as 'claude' | 'gemini' | 'openai',
  coderModel: (process.env.CODER_MODEL || 'gemini') as 'claude' | 'gemini' | 'openai',
  
  // QA Vision model: 'gpt-4o' | 'gemini'
  qaModel: (process.env.QA_MODEL || 'gemini') as 'gpt-4o' | 'gemini',
};

