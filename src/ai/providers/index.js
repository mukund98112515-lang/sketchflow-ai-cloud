"use strict";

const config = require("../../config");
const { GeminiProvider } = require("./gemini");
const { OpenAIProvider } = require("./openai");
const { XaiProvider } = require("./xai");

let instance = null;

function getProvider() {
  if (instance) return instance;

  if (!config.xaiApiKey && !config.aiApiKey) {
    return null;
  }

  const provider = (config.aiProvider || "xai").toLowerCase();

  switch (provider) {
    case "xai":
    case "grok":
      if (!config.xaiApiKey) return null;
      instance = new XaiProvider(config);
      break;
    case "gemini":
    case "google":
      if (!config.aiApiKey) return null;
      instance = new GeminiProvider(config);
      break;
    case "openai":
      if (!config.aiApiKey) return null;
      instance = new OpenAIProvider(config);
      break;
    default:
      if (config.xaiApiKey) {
        instance = new XaiProvider(config);
      } else if (config.aiApiKey) {
        instance = new OpenAIProvider(config);
      }
  }

  return instance;
}

function resetProvider() {
  instance = null;
}

module.exports = { getProvider, resetProvider };
