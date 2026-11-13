#!/bin/zsh
set -eu
cd "${0:A:h}"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 20
fi
npm ci
npm run setup
