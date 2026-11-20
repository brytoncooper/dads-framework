# Compose APIs and plugins

An API entry point chooses its route surfaces and lifecycle. A domain owns
its resource model and supplies the parts it exposes. Keep customer and staff
surfaces explicit, even when they share one storage layer.

Start with [dependency libraries](../../dependency-libraries.md) to locate
shared dependencies and keep foreign adapters at the integration boundary.
The [plugin package](../../../packages/foundation/plugin/README.md) explains
how a host wires a plugin's routes, jobs, services, and migrations at build
time. [The notes fixture](../../../fixtures/plugin-notes/README.md) runs those
contributions through the framework. Follow the [walkthrough](./guarded-resource.md)
for the separately composed customer and staff APIs.

The [Independent Evolution Principle](../../principles.md) explains why an
API contract, a domain model, and a provider can change on different
schedules.
