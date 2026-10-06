# Own created and adopted skill files in Monke home

New global skills default to Monke management unless the user explicitly requests
a specific harness. Creation and adoption establish one editable source in Monke
home and reuse the existing personal Skill registry and Skill projections. This
keeps editing authority independent of whichever harness created the skill;
using a harness folder as the authoritative source would make that harness's
installation and cleanup lifecycle control every shared copy.

Existing local imports can continue to retain an external source through
`mt skills add --link`. Adoption transfers source ownership rather than merely
adding distribution links. Duplicate discovery and conflicting copies are defined
in the [creation and adoption Spec](https://github.com/monke-together-strong/monke-tools/issues/214).
