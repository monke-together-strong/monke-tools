# Tool installation and releases

Part of the [domain glossary](../../GLOSSARY.md).

## Installs and activation

**Local tool install**: A monke-tools install built from a source checkout and shared across **Consumer repos**.

**Release install**: A monke-tools install obtained from an official stable release.

**Customized release install**: A **Release install** whose packaged skills, references, repo import recipes, or global instructions differ from the release bundle.

**Active tool install**: The **Local tool install** or **Release install** currently selected in a **Monke home**.

**Tool build identity**: The human-readable version identity of an installed monke-tools build.

**Install activation**: Selection of an install as the **Active tool install**.

**Install manifest**: The provenance record belonging to one install. _Avoid_: Global monke config, release notes, lock file

**Update staging directory**: Temporary storage for a candidate release before **Install activation**.

**Installation mutation lock**: Exclusive ownership of tool-managed installation changes.

**Local install refresh**: Rebuilding a **Local tool install** from its source checkout.

**Installed source checkout**: The source checkout associated with the active **Local tool install**.

**Skill authoring mode**: Use of a **Local tool install** whose distributed guidance remains editable in its **Installed source checkout**.

**Global monke config**: Machine-local preferences shared across **Consumer repos**. _Avoid_: Repo config, session state, monke.yml

## Releases

**Release bundle**: A platform-specific release artifact containing the executable and its matching distributed guidance.

**Release update**: Replacement of the active install with a selected official stable release.

**Release installer**: The first-install workflow for a verified **Release bundle**.

**Release bootstrap**: The public entrypoint that discovers a compatible **Release bundle** and starts installation.

**Mainline release**: A stable monke-tools release published from validated mainline changes.

**Codiff runtime dependency**: The separately installed Codiff executable required by the desktop **Diff adapter**.

**Shared Oxc presets**: Team-owned lint and format policy distributed across **Consumer repos**.

**Release entry**: A pending description of a consumer-visible package change and its intended version impact.

**Release PR**: A pull request that applies pending package versions and release notes for publication.

## Relationships

- **Consumer repos** using the same **Monke home** share an **Active tool install**.
- Each install has its own **Install manifest**. **Global monke config** belongs to its **Monke home**.
- A **Local tool install** has an **Installed source checkout**. A **Release install** has a **Release bundle** as its origin.
- **Distributed skills**, **Distributed references**, and **Global agent instructions** belong to the installed version. **Codiff** has an independent release lifecycle.
- **Skill authoring mode** keeps guidance changes in the source checkout; a **Customized release install** carries changes in installed release content.
