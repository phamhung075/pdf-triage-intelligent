export interface ContactInfoProps {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  website?: string;
}

export class ContactInfo {
  private readonly name: string;
  private readonly email: string;
  private readonly phone: string;
  private readonly address: string;
  private readonly website: string;

  constructor(props: ContactInfoProps = {}) {
    this.name = (props.name || '').trim();
    this.email = (props.email || '').trim();
    this.phone = (props.phone || '').trim();
    this.address = (props.address || '').trim();
    this.website = (props.website || '').trim();
  }

  public getName(): string { return this.name; }
  public getEmail(): string { return this.email; }
  public getPhone(): string { return this.phone; }
  public getAddress(): string { return this.address; }
  public getWebsite(): string { return this.website; }

  public hasAnyContact(): boolean {
    return Boolean(this.name || this.email || this.phone || this.address || this.website);
  }

  public toJSON(): ContactInfoProps {
    return {
      name: this.name,
      email: this.email,
      phone: this.phone,
      address: this.address,
      website: this.website
    };
  }
}
