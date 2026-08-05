const secureBraceExpansion = require("brace-expansion-secure");

function braceExpand(pattern, options) {
  return secureBraceExpansion.expand(pattern, options);
}

braceExpand.expand = secureBraceExpansion.expand;
braceExpand.EXPANSION_MAX = secureBraceExpansion.EXPANSION_MAX;

module.exports = braceExpand;
