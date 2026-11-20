'use strict';
// Template Terraform dari rencana Planning: server (compute + disk + IP publik) per platform.
// Tidak ada kredensial di file: provider membaca kredensial dari environment atau CLI login
// masing-masing platform.
const pricing = require('./pricing');

const IMG = {
  // Image Linux umum. Bisa diganti di variables setelah diunduh.
  aws: 'data.aws_ami.ubuntu.id',
  azure: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' },
  gcp: 'ubuntu-os-cloud/ubuntu-2404-lts-amd64',
};
const ARM = { gcp: 'ubuntu-os-cloud/ubuntu-2404-lts-arm64' };

const slug = (s, i) => (String(s || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'server') + (i ? `-${i}` : '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function build(items, name = 'rencana') {
  const servers = items.filter((x) => x.kind === 'server' && pricing.byType(x.provider, x.type));
  const used = [...new Set(servers.map((s) => s.provider))];
  const base = slug(name);
  const out = [];
  out.push(`# Template Terraform dari Planning VPS FinOps Agent: ${String(name).replace(/[\r\n]/g, ' ')}`);
  out.push('# Region US East, sama dengan harga di Planning. Periksa dulu dengan `terraform plan` sebelum `apply`.');
  out.push('# Kredensial tidak disimpan di file ini. Login lewat CLI masing-masing platform atau environment variable.');
  out.push('');
  out.push('terraform {');
  out.push('  required_version = ">= 1.5"');
  out.push('  required_providers {');
  if (used.includes('aws')) out.push('    aws = { source = "hashicorp/aws", version = "~> 5.0" }');
  if (used.includes('azure')) out.push('    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }');
  if (used.includes('gcp')) out.push('    google = { source = "hashicorp/google", version = "~> 6.0" }');
  out.push('  }');
  out.push('}');
  out.push('');
  out.push('variable "name_prefix" {');
  out.push(`  default = "${base}"`);
  out.push('}');
  if (used.includes('gcp')) {
    out.push('');
    out.push('variable "gcp_project" {');
    out.push('  description = "ID project Google Cloud"');
    out.push('  type        = string');
    out.push('}');
  }
  if (used.includes('azure')) {
    out.push('');
    out.push('variable "azure_ssh_public_key" {');
    out.push('  description = "Isi public key SSH untuk login ke VM Azure"');
    out.push('  type        = string');
    out.push('}');
  }

  if (used.includes('aws')) {
    out.push('', '# ---------- AWS ----------');
    out.push('provider "aws" {');
    out.push(`  region = "${pricing.PROVIDERS.aws.region.code}"`);
    out.push('}');
    const arches = [...new Set(servers.filter((s) => s.provider === 'aws').map((s) => pricing.byType('aws', s.type).arch))];
    for (const a of arches) {
      out.push('');
      out.push(`data "aws_ami" "ubuntu${a === 'arm64' ? '_arm' : ''}" {`);
      out.push('  most_recent = true');
      out.push('  owners      = ["099720109477"] # Canonical');
      out.push('  filter {');
      out.push('    name   = "name"');
      out.push(`    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${a === 'arm64' ? 'arm64' : 'amd64'}-server-*"]`);
      out.push('  }');
      out.push('}');
    }
  }
  if (used.includes('azure')) {
    out.push('', '# ---------- Azure ----------');
    out.push('provider "azurerm" {');
    out.push('  features {}');
    out.push('}');
    out.push('');
    out.push('resource "azurerm_resource_group" "main" {');
    out.push('  name     = "${var.name_prefix}-rg"');
    out.push(`  location = "${pricing.PROVIDERS.azure.region.code}"`);
    out.push('}');
    out.push('');
    out.push('resource "azurerm_virtual_network" "main" {');
    out.push('  name                = "${var.name_prefix}-vnet"');
    out.push('  address_space       = ["10.10.0.0/16"]');
    out.push('  location            = azurerm_resource_group.main.location');
    out.push('  resource_group_name = azurerm_resource_group.main.name');
    out.push('}');
    out.push('');
    out.push('resource "azurerm_subnet" "main" {');
    out.push('  name                 = "default"');
    out.push('  resource_group_name  = azurerm_resource_group.main.name');
    out.push('  virtual_network_name = azurerm_virtual_network.main.name');
    out.push('  address_prefixes     = ["10.10.1.0/24"]');
    out.push('}');
  }
  if (used.includes('gcp')) {
    out.push('', '# ---------- Google Cloud ----------');
    out.push('provider "google" {');
    out.push('  project = var.gcp_project');
    out.push(`  region  = "${pricing.PROVIDERS.gcp.region.code}"`);
    out.push('}');
  }

  const outputs = [];
  servers.forEach((s, idx) => {
    const t = pricing.byType(s.provider, s.type);
    const count = Math.max(1, Math.min(50, Math.round(num(s.qty, 1))));
    const disk = Math.max(8, Math.round(num(s.diskGB, 30)));
    const r = `srv${idx + 1}`;
    const monthly = pricing.serverMonthly(s.provider, s.type, disk).total;
    out.push('');
    out.push(`# ${s.type}: ${t.vcpu} vCPU, ${t.memGiB} GiB, disk ${disk} GB. Perkiraan ${monthly.toFixed(2)} USD per bulan per server.`);
    if (s.provider === 'aws') {
      out.push(`resource "aws_instance" "${r}" {`);
      if (count > 1) out.push(`  count         = ${count}`);
      out.push(`  ami           = data.aws_ami.ubuntu${t.arch === 'arm64' ? '_arm' : ''}.id`);
      out.push(`  instance_type = "${s.type}"`);
      out.push('  root_block_device {');
      out.push(`    volume_size = ${disk}`);
      out.push('    volume_type = "gp3"');
      out.push('  }');
      out.push('  tags = {');
      out.push(`    Name = "\${var.name_prefix}-${r}${count > 1 ? '-${count.index + 1}' : ''}"`);
      out.push('  }');
      out.push('}');
      outputs.push(`output "${r}_public_ip" {\n  value = ${count > 1 ? `aws_instance.${r}[*].public_ip` : `aws_instance.${r}.public_ip`}\n}`);
    } else if (s.provider === 'azure') {
      const c = count > 1 ? `  count               = ${count}\n` : '';
      const ix = count > 1 ? '-${count.index + 1}' : '';
      const ref = (res) => (count > 1 ? `${res}[count.index]` : res);
      out.push(`resource "azurerm_public_ip" "${r}" {`);
      if (count > 1) out.push(`  count               = ${count}`);
      out.push(`  name                = "\${var.name_prefix}-${r}${ix}-ip"`);
      out.push('  location            = azurerm_resource_group.main.location');
      out.push('  resource_group_name = azurerm_resource_group.main.name');
      out.push('  allocation_method   = "Static"');
      out.push('  sku                 = "Standard"');
      out.push('}');
      out.push('');
      out.push(`resource "azurerm_network_interface" "${r}" {`);
      if (count > 1) out.push(`  count               = ${count}`);
      out.push(`  name                = "\${var.name_prefix}-${r}${ix}-nic"`);
      out.push('  location            = azurerm_resource_group.main.location');
      out.push('  resource_group_name = azurerm_resource_group.main.name');
      out.push('  ip_configuration {');
      out.push('    name                          = "ipconfig"');
      out.push('    subnet_id                     = azurerm_subnet.main.id');
      out.push('    private_ip_address_allocation = "Dynamic"');
      out.push(`    public_ip_address_id          = ${ref(`azurerm_public_ip.${r}`)}.id`);
      out.push('  }');
      out.push('}');
      out.push('');
      out.push(`resource "azurerm_linux_virtual_machine" "${r}" {`);
      out.push(c.replace(/\n$/, '') || null);
      out.push(`  name                  = "\${var.name_prefix}-${r}${ix}"`);
      out.push('  location              = azurerm_resource_group.main.location');
      out.push('  resource_group_name   = azurerm_resource_group.main.name');
      out.push(`  size                  = "${s.type}"`);
      out.push('  admin_username        = "azureuser"');
      out.push(`  network_interface_ids = [${ref(`azurerm_network_interface.${r}`)}.id]`);
      out.push('  admin_ssh_key {');
      out.push('    username   = "azureuser"');
      out.push('    public_key = var.azure_ssh_public_key');
      out.push('  }');
      out.push('  os_disk {');
      out.push('    caching              = "ReadWrite"');
      out.push('    storage_account_type = "StandardSSD_LRS"');
      out.push(`    disk_size_gb         = ${Math.max(30, disk)}`);
      out.push('  }');
      out.push('  source_image_reference {');
      out.push(`    publisher = "${IMG.azure.publisher}"`);
      out.push(`    offer     = "${t.arch === 'arm64' ? 'ubuntu-24_04-lts' : IMG.azure.offer}"`);
      out.push(`    sku       = "${t.arch === 'arm64' ? 'server-arm64' : IMG.azure.sku}"`);
      out.push(`    version   = "${IMG.azure.version}"`);
      out.push('  }');
      out.push('}');
      outputs.push(`output "${r}_public_ip" {\n  value = ${count > 1 ? `azurerm_public_ip.${r}[*].ip_address` : `azurerm_public_ip.${r}.ip_address`}\n}`);
    } else if (s.provider === 'gcp') {
      out.push(`resource "google_compute_instance" "${r}" {`);
      if (count > 1) out.push(`  count        = ${count}`);
      out.push(`  name         = "\${var.name_prefix}-${r}${count > 1 ? '-${count.index + 1}' : ''}"`);
      out.push(`  machine_type = "${s.type}"`);
      out.push(`  zone         = "${pricing.PROVIDERS.gcp.region.code}-b"`);
      out.push('  boot_disk {');
      out.push('    initialize_params {');
      out.push(`      image = "${t.arch === 'arm64' ? ARM.gcp : IMG.gcp}"`);
      out.push(`      size  = ${Math.max(10, disk)}`);
      out.push('      type  = "pd-balanced"');
      out.push('    }');
      out.push('  }');
      out.push('  network_interface {');
      out.push('    network = "default"');
      out.push('    access_config {}');
      out.push('  }');
      out.push('}');
      outputs.push(`output "${r}_public_ip" {\n  value = ${count > 1 ? `google_compute_instance.${r}[*].network_interface[0].access_config[0].nat_ip` : `google_compute_instance.${r}.network_interface[0].access_config[0].nat_ip`}\n}`);
    }
  });

  if (outputs.length) out.push('', ...outputs);
  return out.filter((x) => x !== null).join('\n') + '\n';
}

module.exports = { build };
