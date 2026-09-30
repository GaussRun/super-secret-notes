# Super Secret Notes CLI demo (super-secret-notes, zero-signup defaults). Render from overkill/cli with an existing
# vault on the default backends and an empty directory for the "new laptop":
#   OVERKILL_HOME=<vault dir> OVERKILL_PASSPHRASE_FILE=<0600 file> NEW_LAPTOP=<empty dir> vhs demo/demo.tape
# All three come from the environment, so no path or secret is typed on screen.
Output demo/overkill-cli.gif

Set Shell "bash"
Set FontSize 18
Set Width 1320
Set Height 560
Set Padding 24
Set TypingSpeed 90ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
# live network calls are slow; play back at 4x (pauses below are in recording time)
Set PlaybackSpeed 4

Hide
Type "export PS1='$ ' OVERKILL_LOG=warn; alias super-secret-notes='node bin/super-secret-notes.js'; clear" Enter
Sleep 500ms
Show

Type "# one note you cannot lose: 12 independent zero-signup hosts, encrypted before it leaves" Sleep 400ms Enter
Type "echo 'github: 7f3a-91c2-d4e8, bank: 5b61-0e9f-a2c7' | super-secret-notes put 'recovery codes'" Sleep 400ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 10s
Type "super-secret-notes check" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 12s
Ctrl+L
Type "super-secret-notes chaos pb-envs 'recovery codes'" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 6s
Type "super-secret-notes check" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 12s
Ctrl+L
Type "super-secret-notes get 'recovery codes'" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 10s
Type "super-secret-notes repair" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 6s
Type "super-secret-notes check" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 12s
Ctrl+L
Type "# meanwhile, on a brand-new laptop: just the vault name and the passphrase" Sleep 400ms Enter
Type "export OVERKILL_HOME=$NEW_LAPTOP" Sleep 300ms Enter
Type "super-secret-notes recover --name overkill-dev-cli-zero" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 12s
Type "super-secret-notes get 'recovery codes'" Sleep 300ms Enter
Wait+Line@180s /^\$\s*$/
Sleep 16s
