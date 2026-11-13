#!/bin/zsh
set -eu
cd "${0:A:h}"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use 20
fi
# Follow the current macOS HTTPS proxy unless explicitly configured.
if [[ -z "${REAUTH_PROXY:-}" ]]; then
  proxy_config=$(scutil --proxy)
  proxy_enabled=$(print -r -- "$proxy_config" | awk '/HTTPSEnable/ {print $3}')
  if [[ "$proxy_enabled" == "1" ]]; then
    proxy_host=$(print -r -- "$proxy_config" | awk '/HTTPSProxy/ {print $3}')
    proxy_port=$(print -r -- "$proxy_config" | awk '/HTTPSPort/ {print $3}')
    export REAUTH_PROXY="http://${proxy_host}:${proxy_port}"
  fi
fi
exec node server.mjs
